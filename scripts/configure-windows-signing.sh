#!/usr/bin/env bash
# Configures Azure Trusted Signing for the Windows bundle legs of the release
# workflow. Run from the repo root (shell: bash). Its outputs — GITHUB_PATH /
# GITHUB_ENV writes and a generated overlay config — make the later tauri
# bundle step sign the app exe + installers via scripts/sign-windows.ps1.
#
# No-op (builds UNSIGNED) when AZURE_CLIENT_ID is unset, so releases still work
# before Azure is configured. The signCommand lives in a CI-only overlay
# (passed with --config) rather than tauri.conf.json / tauri.windows.conf.json,
# because those apply to every Windows build — including local/contributor
# builds that lack the Azure creds + signing tooling.
set -euo pipefail

if [ -z "${AZURE_CLIENT_ID:-}" ]; then
  echo "::warning::AZURE_CLIENT_ID unset — building UNSIGNED Windows bundle."
  exit 0
fi

# artifact-signing-cli shells out to signtool but doesn't bundle it. The
# Windows SDK ships signtool under a versioned, per-arch dir that isn't on
# PATH — locate the newest and prepend it (via GITHUB_PATH) for the bundle step.
arch=x64
[ "${RUNNER_ARCH:-}" = "ARM64" ] && arch=arm64
sdkbin="/c/Program Files (x86)/Windows Kits/10/bin"
stdir=$(ls -d "$sdkbin"/10.*/"$arch" 2>/dev/null | sort -V | tail -1 || true)
if [ -n "${stdir:-}" ] && [ -f "$stdir/signtool.exe" ]; then
  cygpath -w "$stdir" >> "$GITHUB_PATH"
else
  echo "::warning::signtool.exe not found under $sdkbin/10.*/$arch — signing will fail."
fi

# Resolve an absolute path to the Git-bash executable that runs the sign
# wrapper. We don't rely on PATH: tauri spawns the signCommand via
# Command::new(cmd) with no PATH search, and `bash` isn't on the bundle step's
# process PATH. The {cmd,args} object form below takes this absolute path
# directly (no PATH lookup, no whitespace splitting).
bash_exe="$(command -v bash || true)"
if [ -z "$bash_exe" ] || [ ! -f "$bash_exe" ]; then
  echo "::error::bash executable not found on the runner"
  exit 1
fi

cargo install artifact-signing-cli --locked

# Overlay config built with jq (handles JSON backslash-escaping of the cmd
# path) using signCommand's {cmd,args} OBJECT form: no whitespace splitting,
# no PATH lookup, no relative-path rewrite. %1 is substituted by tauri with
# each file to sign. cmd = bash.exe (Windows path); the script arg uses a
# forward-slash drive path (cygpath -m) so it stays absolute (tauri leaves it)
# and Git-bash opens it cleanly. The wrapper reads TS_*/AZURE_* from the env.
bash_win="$(cygpath -w "$bash_exe")"
script_win="$(cygpath -m "$PWD/scripts/sign-windows.sh")"
jq -n --arg cmd "$bash_win" --arg script "$script_win" \
  '{bundle:{windows:{signCommand:{cmd:$cmd,args:[$script,"%1"]}}}}' \
  > src-tauri/tauri.signing.conf.json
echo "SIGN_CONFIG_ARG=--config src-tauri/tauri.signing.conf.json" >> "$GITHUB_ENV"
