# vendor/ — libghostty-rs as a pinned submodule + patch

We build against [`libghostty-rs`](https://github.com/uzaaft/libghostty-rs)
directly from GitHub instead of crates.io, with our changes kept as a
single reviewable diff rather than a vendored source copy.

| Path | What |
|---|---|
| `libghostty-rs/` | Git submodule, pinned to a specific upstream commit (the gitlink in the parent repo records which). |
| `libghostty-vt-sys.patch` | Our changes to `crates/libghostty-vt-sys/build.rs`, as `git diff` output. |
| `../../scripts/setup-vendor.sh` | Initializes the submodule and applies the patch. Idempotent. |

`src-tauri/Cargo.toml` has a `[patch.crates-io]` that points **both**
`libghostty-vt` and `libghostty-vt-sys` at subdirs of the submodule, so
the high-level API and the FFI bindings always come from the same
pinned upstream commit (mixing crates.io's `libghostty-vt` with a
patched `-sys` risks struct-layout skew).

## First-time setup / after a fresh clone

```bash
bun run setup-vendor      # = scripts/setup-vendor.sh
cd src-tauri && cargo check
```

Cargo cannot apply a patch on its own, so `setup-vendor` is a required
manual step before the first build (and after any submodule bump).

## What the patch changes

All in `crates/libghostty-vt-sys/build.rs`:

- `zig_target` recognizes iOS / Android / Windows triples (upstream
  handles only desktop Linux + macOS), so a cross-compile attempt
  doesn't panic on an unknown triple.
- iOS cross builds pin `-Dcpu=apple_a14` — the iPhoneSimulator 17+ SDK
  headers reject the `baseline` CPU Zig would otherwise default to.
- iOS links a self-contained static archive: `merge_ios_cpp_deps` folds
  simdutf / highway / utfcpp into `libghostty-vt-ios.a` (the static
  install path otherwise drops the C++ deps).
- Re-exports `cargo:libdir` / `cargo:lib_filename` so prmpt's own
  `build.rs` can stage the dylib into the macOS `.app`'s
  `Contents/Frameworks/`.

These layer cleanly on top of upstream's own static-link / pkg-config
support (added after the 0.1.1 crates.io release this used to vendor).

## Bumping the pinned upstream commit

```bash
cd src-tauri/vendor/libghostty-rs
git fetch origin
git checkout <new-commit>
git apply ../libghostty-vt-sys.patch          # re-apply on top
# ...resolve any rejects, re-edit build.rs by hand if needed...
git diff > ../libghostty-vt-sys.patch         # regenerate the patch
cd ../../.. && git add src-tauri/vendor/libghostty-rs src-tauri/vendor/libghostty-vt-sys.patch
cargo check                                   # iOS still needs on-device validation
```

Commit the moved submodule gitlink **and** the regenerated patch
together. Never commit the patched submodule working tree — only the
gitlink (clean upstream commit) and the `.patch` are tracked.

## Upstreaming

The diff is small and target-additive; it should be submitted upstream
so this patch can eventually be dropped and we can depend on a tagged
release directly.
