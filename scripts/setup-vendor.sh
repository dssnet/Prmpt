#!/usr/bin/env bash
# Initialize the libghostty-rs submodule and lay the prmpt fork patch on
# top of it. Idempotent: safe to re-run, a no-op once the patch is
# applied. Run this once after clone (and after any submodule bump)
# before `cargo check` / `bun tauri dev`.
#
# Why a patch and not a vendored copy: we track upstream
# github.com/uzaaft/libghostty-rs at a pinned commit (the submodule
# gitlink) and keep our changes as a reviewable diff. Cargo cannot apply
# a patch itself, hence this step.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
submodule="$repo_root/src-tauri/vendor/libghostty-rs"
patch="$repo_root/src-tauri/vendor/libghostty-vt-sys.patch"

if [[ ! -f "$submodule/.git" && ! -d "$submodule/.git" ]]; then
  echo "==> initializing libghostty-rs submodule"
  git -C "$repo_root" submodule update --init src-tauri/vendor/libghostty-rs
fi

cd "$submodule"

if git apply --reverse --check "$patch" >/dev/null 2>&1; then
  echo "==> prmpt fork patch already applied — nothing to do"
  exit 0
fi

if git apply --check "$patch" >/dev/null 2>&1; then
  git apply "$patch"
  echo "==> applied prmpt fork patch onto $(git rev-parse --short HEAD)"
  exit 0
fi

echo "ERROR: patch neither cleanly applies nor is already applied." >&2
echo "       The submodule may be on the wrong commit or locally dirty." >&2
echo "       Reset it with: git submodule update --init --force src-tauri/vendor/libghostty-rs" >&2
exit 1
