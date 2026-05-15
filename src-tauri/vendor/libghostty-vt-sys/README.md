# libghostty-vt-sys (vendored fork)

Local copy of [`libghostty-vt-sys`](https://crates.io/crates/libghostty-vt-sys)
0.1.1, patched so its `build.rs` recognizes a wider set of target
triples in its `zig_target()` allow-list (iOS, Android, Windows, in
addition to the upstream Linux + macOS).

Wired into the workspace via a `[patch.crates-io]` entry in
`src-tauri/Cargo.toml`.

## Why

The upstream `build.rs` panics with `unsupported Rust target for
vendored build: <triple>` whenever it sees a target it doesn't know how
to translate to a Zig `-Dtarget` flag. That blocks cross-compilation to
iOS / Android / Windows even though Zig itself supports those targets.

## How to update

When upstream releases a new version that supports these targets, drop
this directory and remove the `[patch.crates-io]` entry from
`src-tauri/Cargo.toml`. Until then, on every upstream version bump you
intend to track:

1. Copy the new `src/`, `tools/`, and `Cargo.toml` from the registry
   cache at `~/.cargo/registry/src/.../libghostty-vt-sys-<version>/`.
2. Re-apply the `zig_target()` extensions and the `lib_name` Apple/iOS
   merge documented at the top of `build.rs`.

## Upstream PR

The diff against 0.1.1's `build.rs` is small (an additional ~10 match
arms in `zig_target` and one extension to `lib_name`); it should be
submitted upstream so this directory can eventually be removed.
