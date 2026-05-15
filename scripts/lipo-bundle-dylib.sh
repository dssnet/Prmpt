#!/usr/bin/env bash
# Run from `beforeBundleCommand` in tauri.macos.conf.json. Merges every
# per-target libghostty-vt dylib that src-tauri/build.rs staged into the
# unsuffixed `libghostty-vt.dylib` that tauri.conf.json's
# `bundle.macOS.frameworks` entry points at.
#
# Why: Tauri's universal-apple-darwin build runs cargo separately for
# `aarch64-apple-darwin` and `x86_64-apple-darwin`. Each pass overwrites
# `src-tauri/native/libghostty-vt.dylib`, so by the time the bundler
# runs the unsuffixed file only contains the last-built arch and the
# universal binary fails at launch with:
#   "incompatible architecture (have 'x86_64', need 'arm64')"
# This script lipos the per-target copies back together.
#
# For single-arch builds there's only one per-target file and
# `lipo -create` produces a fat archive with one slice — effectively a
# copy.

set -euo pipefail

# Run from the project root regardless of where the caller cd'd to.
cd "$(dirname "$0")/.."

NATIVE_DIR="src-tauri/native"
TARGET="$NATIVE_DIR/libghostty-vt.dylib"

if [ ! -d "$NATIVE_DIR" ]; then
  echo "lipo-bundle-dylib: $NATIVE_DIR does not exist; nothing to do" >&2
  exit 0
fi

# Only the macOS (apple-darwin) per-target slices belong in a macOS .app.
# Deliberately *not* `*-apple-*`: that also matches stale iOS triples
# (aarch64-apple-ios, aarch64-apple-ios-sim) which are all arm64, and
# `lipo -create` rejects two slices of the same architecture.
shopt -s nullglob
ARCH_FILES=( "$NATIVE_DIR"/libghostty-vt.*-apple-darwin.dylib )

if [ "${#ARCH_FILES[@]}" -eq 0 ]; then
  echo "lipo-bundle-dylib: no per-target dylibs in $NATIVE_DIR; leaving $TARGET as-is" >&2
  exit 0
fi

echo "lipo-bundle-dylib: merging ${#ARCH_FILES[@]} per-target file(s) into $TARGET" >&2
for f in "${ARCH_FILES[@]}"; do
  echo "  - $f ($(file -b "$f" | head -1))" >&2
done

lipo -create -output "$TARGET" "${ARCH_FILES[@]}"

echo "lipo-bundle-dylib: result -> $(file -b "$TARGET" | head -1)" >&2
