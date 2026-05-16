use std::{env, fs, path::PathBuf};

fn main() {
    // Order matters: `tauri_build::build()` validates `tauri.conf.json`,
    // and `bundle.macOS.frameworks` references a path that doesn't
    // exist on a clean checkout until we stage it. Stage first, then
    // run the Tauri build script.
    stage_native_lib();

    let target = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();

    // Tell dyld to look in `Contents/Frameworks/` (where Tauri's
    // bundler puts the staged dylib). The OUT_DIR rpath that Cargo
    // embeds for dev builds remains in place; dyld tries each rpath in
    // turn, so both code paths work.
    if target == "macos" || target == "ios" {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
    }

    tauri_build::build();
}

// libghostty-vt-sys ships a shared lib that the binary depends on at
// runtime. Tauri's bundler doesn't see it unless it's at a path the
// config can name. We rely on Cargo's `links = "ghostty-vt"` bridge:
// our patched libghostty-vt-sys build script emits `cargo:libdir=...`
// and `cargo:lib_filename=...`, and Cargo forwards those to us as
// `DEP_GHOSTTY_VT_LIBDIR` and `DEP_GHOSTTY_VT_LIB_FILENAME`. For that
// to work, this crate must depend on `libghostty-vt-sys` directly (not
// only transitively through `libghostty-vt`), which is set up in
// Cargo.toml.
//
// Without this staging step the bundled .app crashes at launch with:
//   "Library not loaded: @rpath/libghostty-vt.dylib
//    (no LC_RPATH's found)"
fn stage_native_lib() {
    // iOS links libghostty-vt statically into libprmpt_lib.a — there's
    // no transitive dylib for the .app to load at runtime, so the whole
    // stage-into-native/ dance is unnecessary (and would emit a `.a`
    // under a `.dylib` name, since the rename below assumes Mach-O dylib).
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        return;
    }

    let libdir = match env::var("DEP_GHOSTTY_VT_LIBDIR") {
        Ok(v) => v,
        Err(_) => {
            println!(
                "cargo:warning=DEP_GHOSTTY_VT_LIBDIR unset \u{2014} is libghostty-vt-sys a direct dependency?"
            );
            return;
        }
    };
    let lib_filename = match env::var("DEP_GHOSTTY_VT_LIB_FILENAME") {
        Ok(v) => v,
        Err(_) => {
            println!("cargo:warning=DEP_GHOSTTY_VT_LIB_FILENAME unset");
            return;
        }
    };

    let src = PathBuf::from(&libdir).join(&lib_filename);
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let staged_dir = manifest_dir.join("native");
    if let Err(e) = fs::create_dir_all(&staged_dir) {
        println!("cargo:warning=failed to create {}: {e}", staged_dir.display());
        return;
    }

    if !src.exists() {
        println!(
            "cargo:warning=libghostty-vt source not found at {} (libdir={libdir})",
            src.display()
        );
        return;
    }

    // The dylib's install_name (baked in by Zig) is the *unversioned*
    // soname `@rpath/libghostty-vt.dylib`. Stage with that name so the
    // bundle path matches. We also write a per-target-triple copy so
    // that Tauri's universal-apple-darwin build (which runs cargo once
    // per arch, with each run overwriting the unsuffixed file) doesn't
    // lose the previous arch's dylib. The `lipo-bundle-dylib.sh` hook
    // merges those per-target copies into the unsuffixed file just
    // before bundling — for single-arch builds this is a no-op copy,
    // for universal it produces a fat dylib.
    let target_os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let target_triple = env::var("TARGET").unwrap_or_default();
    let unsuffixed_filename = if target_os == "macos" || target_os == "ios" {
        "libghostty-vt.dylib".to_string()
    } else {
        lib_filename.clone()
    };
    let unsuffixed = staged_dir.join(&unsuffixed_filename);

    if let Err(e) = fs::copy(&src, &unsuffixed) {
        println!(
            "cargo:warning=failed to stage libghostty-vt: {e} (src={}, dst={})",
            src.display(),
            unsuffixed.display(),
        );
        return;
    }

    // Apple-only side copy keyed by target triple — `lipo-bundle-dylib`
    // collects every `libghostty-vt.<triple>.dylib` and merges them
    // back into the unsuffixed file at bundle time.
    if target_os == "macos" || target_os == "ios" {
        let per_target = staged_dir.join(format!("libghostty-vt.{target_triple}.dylib"));
        if let Err(e) = fs::copy(&src, &per_target) {
            println!(
                "cargo:warning=failed to stage per-target libghostty-vt: {e} (src={}, dst={})",
                src.display(),
                per_target.display(),
            );
        }
    }

    // Windows: Ghostty's Zig build emits both `ghostty-vt-static.lib`
    // (what `pick_lib_filename` reports, so `src` above points there)
    // and a DLL + its import lib `ghostty-vt.lib`. The MSVC linker
    // resolves `static=ghostty-vt` through that import lib, so
    // prmpt.exe ends up with a runtime dependency on `ghostty-vt.dll`
    // regardless of the static archive. Stage that DLL so
    // tauri.windows.conf.json can bundle it next to the executable;
    // without it the app aborts at launch with
    // "ghostty-vt.dll nicht gefunden".
    if target_os == "windows" {
        let dll_src = PathBuf::from(&libdir).join("ghostty-vt.dll");
        let dll_dst = staged_dir.join("ghostty-vt.dll");
        if !dll_src.exists() {
            println!(
                "cargo:warning=ghostty-vt.dll not found at {} — Windows bundle will crash at launch",
                dll_src.display()
            );
        } else if let Err(e) = fs::copy(&dll_src, &dll_dst) {
            println!(
                "cargo:warning=failed to stage ghostty-vt.dll: {e} (src={}, dst={})",
                dll_src.display(),
                dll_dst.display(),
            );
        }
    }
}
