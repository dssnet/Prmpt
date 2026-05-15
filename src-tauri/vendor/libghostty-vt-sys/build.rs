use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

// Vendored from libghostty-vt-sys 0.1.1 (crates.io). Differences from
// upstream:
//   * `zig_target` recognizes iOS, Android, and Windows triples so we
//     can at least *attempt* a cross-compile without panicking. Upstream
//     only handles desktop Linux + macOS.
//   * `lib_name` treats every Apple target (darwin or ios) as producing
//     a `.dylib`, and recognizes Windows DLLs.
//   * Re-exports `cargo:libdir=...` so the consuming crate (`prmpt`)
//     can stage the dylib into the macOS `.app`'s `Contents/Frameworks/`
//     via its own build.rs. Without that, dyld fails to locate
//     `@rpath/libghostty-vt.dylib` once the binary is moved out of
//     `target/`.
// See vendor/libghostty-vt-sys/README.md for the rationale and upstream
// PR plan.

const GHOSTTY_REPO: &str = "https://github.com/ghostty-org/ghostty.git";
const GHOSTTY_COMMIT: &str = "bebca84668947bfc92b9a30ed58712e1c34eee1d";

fn main() {
    if env::var("DOCS_RS").is_ok() {
        return;
    }

    println!("cargo:rerun-if-env-changed=LIBGHOSTTY_VT_SYS_NO_VENDOR");
    println!("cargo:rerun-if-env-changed=GHOSTTY_SOURCE_DIR");
    println!("cargo:rerun-if-env-changed=TARGET");
    println!("cargo:rerun-if-env-changed=HOST");
    println!("cargo:rerun-if-changed=build.rs");

    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR must be set"));
    let target = env::var("TARGET").expect("TARGET must be set");
    let host = env::var("HOST").expect("HOST must be set");

    let ghostty_dir = match env::var("GHOSTTY_SOURCE_DIR") {
        Ok(dir) => {
            let p = PathBuf::from(dir);
            assert!(
                p.join("build.zig").exists(),
                "GHOSTTY_SOURCE_DIR does not contain build.zig: {}",
                p.display()
            );
            p
        }
        Err(_) => fetch_ghostty(&out_dir),
    };

    let install_prefix = out_dir.join("ghostty-install");

    let mut build = Command::new("zig");
    build
        .arg("build")
        .arg("-Demit-lib-vt")
        .arg("--prefix")
        .arg(&install_prefix)
        .current_dir(&ghostty_dir);

    if target != host {
        let zig_target = zig_target(&target);
        build.arg(format!("-Dtarget={zig_target}"));

        // Ghostty's build.zig pins macOS to a generic CPU
        // (`genericMacOSTarget` in src/build/Config.zig) but applies no
        // analogous workaround for iOS. Zig then defaults the iOS
        // cross-compile to `-mcpu baseline`, which Xcode 16+ /
        // iPhoneSimulator 17+ SDK headers reject: `arm_neon.h` marks
        // basic intrinsics like `vdupq_n_u8` as `always_inline` with
        // `target("altnzcv")` (FEAT_FlagM2 / ARMv8.5-A), and they
        // refuse to inline into a `baseline` translation unit. Pin to
        // `apple_a14` for aarch64-ios targets — A14 is the floor for
        // iOS 17 (osVersionMin in Ghostty's Config.zig) and includes
        // every feature the simulator headers assume.
        if matches!(target.as_str(), "aarch64-apple-ios" | "aarch64-apple-ios-sim") {
            build.arg("-Dcpu=apple_a14");
        }
    }

    run(build, "zig build");

    // Ghostty's build.zig only installs the Zig half as `libghostty-vt.a`
    // (vt.o, libghostty-vt-static_zcu.o, compiler_rt.o). The C++ deps
    // (simdutf, highway, utfcpp) get linked into the dylib but the
    // static-lib install path drops them on the floor. For iOS we
    // need a self-contained archive, so we merge the C++ deps in via
    // `libtool -static`. The C++ archives are produced under
    // `.zig-cache/o/<hash>/lib*.a`; pick any one of each by name
    // (duplicates exist for shared-vs-static build variants but are
    // ABI-identical).
    if target.contains("apple-ios") {
        merge_ios_cpp_deps(&ghostty_dir, &install_prefix.join("lib"));
    }

    let lib_dir = install_prefix.join("lib");
    let include_dir = install_prefix.join("include");

    // iOS prefers static linking: the final link is run by Xcode (not
    // cargo), so cargo's `rustc-link-lib=dylib=...` directive never
    // reaches the linker that produces the .app binary. A static lib
    // gets pulled into `libprmpt_lib.a` and all `_ghostty_*` symbols
    // resolve inside the Rust staticlib step — no transitive dylib for
    // Xcode to embed or codesign. Ghostty's `build.zig` already emits
    // `libghostty-vt.a` next to the dylib, so it's a flag flip.
    let is_ios = target.contains("apple-ios");
    let static_link = is_ios;

    let lib_filename = if is_ios {
        // Self-contained archive produced by `merge_ios_cpp_deps`,
        // which concatenates the Zig-half `libghostty-vt.a` with the
        // C++ deps. Kept under a distinct name so re-running build.rs
        // against a hot Zig cache doesn't double-merge.
        "libghostty-vt-ios.a"
    } else if target.contains("apple") {
        "libghostty-vt.0.1.0.dylib"
    } else if target.contains("windows") {
        "ghostty-vt.dll"
    } else {
        // Linux (incl. Android NDK) ELF SONAME.
        "libghostty-vt.so.0.1.0"
    };

    assert!(
        lib_dir.join(lib_filename).exists(),
        "expected library at {}",
        lib_dir.join(lib_filename).display()
    );
    assert!(
        include_dir.join("ghostty").join("vt.h").exists(),
        "expected header at {}",
        include_dir.join("ghostty").join("vt.h").display()
    );

    println!("cargo:rustc-link-search=native={}", lib_dir.display());
    if static_link {
        // `ghostty-vt-ios` is the merged archive; `ghostty-vt` would be
        // just the Zig half and would leave simdutf/highway/utfcpp
        // symbols undefined at the Rust staticlib link step.
        println!("cargo:rustc-link-lib=static=ghostty-vt-ios");
        // simdutf has undefined `std::*` symbols. On the device/sim
        // SDK, `libc++.dylib` is at `/usr/lib/libc++.dylib` and is
        // auto-linked by `clang++` during Xcode's link step; emit it
        // explicitly so cargo's own cdylib link (when this crate is
        // built with `--lib`) also resolves them.
        println!("cargo:rustc-link-lib=dylib=c++");
    } else {
        println!("cargo:rustc-link-lib=dylib=ghostty-vt");
    }
    println!("cargo:include={}", include_dir.display());
    // Re-exported as `DEP_GHOSTTY_VT_LIBDIR` to dependent crates' build
    // scripts (cargo derives the env var from the `links` key in
    // Cargo.toml). `prmpt`'s build.rs uses this to stage the dylib into
    // `Contents/Frameworks/` so the bundled app can find it at runtime.
    println!("cargo:libdir={}", lib_dir.display());
    println!("cargo:lib_filename={lib_filename}");
}

fn fetch_ghostty(out_dir: &Path) -> PathBuf {
    let src_dir = out_dir.join("ghostty-src");
    let stamp = src_dir.join(".ghostty-commit");

    if stamp.exists()
        && let Ok(existing) = std::fs::read_to_string(&stamp)
        && existing.trim() == GHOSTTY_COMMIT
    {
        return src_dir;
    }

    if src_dir.exists() {
        std::fs::remove_dir_all(&src_dir)
            .unwrap_or_else(|e| panic!("failed to remove {}: {e}", src_dir.display()));
    }

    eprintln!("Fetching ghostty {GHOSTTY_COMMIT} ...");

    let mut clone = Command::new("git");
    clone
        .arg("clone")
        .arg("--filter=blob:none")
        .arg("--no-checkout")
        .arg(GHOSTTY_REPO)
        .arg(&src_dir);
    run(clone, "git clone ghostty");

    let mut checkout = Command::new("git");
    checkout
        .arg("checkout")
        .arg(GHOSTTY_COMMIT)
        .current_dir(&src_dir);
    run(checkout, "git checkout ghostty commit");

    std::fs::write(&stamp, GHOSTTY_COMMIT).unwrap_or_else(|e| panic!("failed to write stamp: {e}"));

    src_dir
}

fn merge_ios_cpp_deps(ghostty_dir: &Path, lib_dir: &Path) {
    let merged = lib_dir.join("libghostty-vt-ios.a");
    let cache_root = ghostty_dir.join(".zig-cache").join("o");

    // Collect the input archives. The Zig-half `libghostty-vt.a` plus
    // one copy each of the C++ deps. The shared- and static-build
    // variants of libhighway/libutfcpp differ only in build metadata;
    // any copy supplies the same object code.
    let mut archives: Vec<PathBuf> = vec![lib_dir.join("libghostty-vt.a")];
    let mut seen: std::collections::HashSet<&'static str> = std::collections::HashSet::new();

    let entries = std::fs::read_dir(&cache_root).unwrap_or_else(|e| {
        panic!("failed to read {}: {e}", cache_root.display());
    });
    for entry in entries {
        let dir = match entry {
            Ok(e) => e.path(),
            Err(_) => continue,
        };
        for name in ["libsimdutf.a", "libhighway.a", "libutfcpp.a"] {
            let candidate = dir.join(name);
            if candidate.is_file() && seen.insert(name) {
                archives.push(candidate);
            }
        }
    }
    assert!(
        seen.contains("libsimdutf.a")
            && seen.contains("libhighway.a")
            && seen.contains("libutfcpp.a"),
        "expected libsimdutf.a / libhighway.a / libutfcpp.a under {}; found {:?}",
        cache_root.display(),
        seen,
    );

    // We cannot use Apple's `libtool -static`: it silently drops
    // Mach-O archive members that aren't 8-byte aligned, and Zig's
    // archiver doesn't pad. Extracting with `ar x` + re-archiving with
    // `ar rcs` sidesteps the alignment check. `ar x` produces files
    // with mode 000; chmod via `chmod u+r` so we can re-archive them.
    let work_dir = lib_dir.join("ios-merge-work");
    let _ = std::fs::remove_dir_all(&work_dir);
    std::fs::create_dir_all(&work_dir)
        .unwrap_or_else(|e| panic!("failed to create {}: {e}", work_dir.display()));

    let mut objects: Vec<PathBuf> = Vec::new();
    for (idx, archive) in archives.iter().enumerate() {
        let subdir = work_dir.join(format!("a{idx}"));
        std::fs::create_dir_all(&subdir)
            .unwrap_or_else(|e| panic!("failed to create {}: {e}", subdir.display()));

        let mut extract = Command::new("ar");
        extract.arg("x").arg(archive).current_dir(&subdir);
        run(extract, &format!("ar x {}", archive.display()));

        for entry in std::fs::read_dir(&subdir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|s| s.to_str()) == Some("o") {
                let mut chmod = Command::new("chmod");
                chmod.arg("u+rw").arg(&path);
                run(chmod, "chmod u+rw extracted object");
                objects.push(path);
            }
        }
    }
    assert!(
        !objects.is_empty(),
        "no objects extracted from input archives: {:?}",
        archives,
    );

    let _ = std::fs::remove_file(&merged);
    let mut cmd = Command::new("ar");
    cmd.arg("rcs").arg(&merged);
    for o in &objects {
        cmd.arg(o);
    }
    run(cmd, "ar rcs libghostty-vt-ios.a");

    // Working dir can grow large; reclaim space now that the merged
    // archive contains everything we need.
    let _ = std::fs::remove_dir_all(&work_dir);
}

fn run(mut command: Command, context: &str) {
    let status = command
        .status()
        .unwrap_or_else(|error| panic!("failed to execute {context}: {error}"));
    assert!(status.success(), "{context} failed with status {status}");
}

/// Map a Rust target triple to the Zig `-Dtarget` triple. Zig 0.15
/// supports many more targets than upstream's allow-list; the additions
/// past macOS/Linux are iOS, Android, and Windows.
fn zig_target(target: &str) -> String {
    let value = match target {
        // Linux desktop
        "x86_64-unknown-linux-gnu" => "x86_64-linux-gnu",
        "x86_64-unknown-linux-musl" => "x86_64-linux-musl",
        "aarch64-unknown-linux-gnu" => "aarch64-linux-gnu",
        "aarch64-unknown-linux-musl" => "aarch64-linux-musl",

        // macOS
        "aarch64-apple-darwin" => "aarch64-macos-none",
        "x86_64-apple-darwin" => "x86_64-macos-none",

        // iOS — device + simulator
        "aarch64-apple-ios" => "aarch64-ios-none",
        "aarch64-apple-ios-sim" => "aarch64-ios-simulator",
        "x86_64-apple-ios" => "x86_64-ios-simulator",

        // Android NDK
        "aarch64-linux-android" => "aarch64-linux-android",
        "armv7-linux-androideabi" => "arm-linux-androideabi",
        "x86_64-linux-android" => "x86_64-linux-android",
        "i686-linux-android" => "x86-linux-android",

        // Windows
        "x86_64-pc-windows-gnu" => "x86_64-windows-gnu",
        "x86_64-pc-windows-msvc" => "x86_64-windows-msvc",
        "aarch64-pc-windows-msvc" => "aarch64-windows-msvc",

        other => panic!("unsupported Rust target for vendored build: {other}"),
    };
    value.to_owned()
}
