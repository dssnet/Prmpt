#!/usr/bin/env bash
# Retry wrapper around artifact-signing-cli, used as tauri's
# bundle.windows.signCommand on the release workflow's Windows legs. tauri
# invokes it as:  bash sign-windows.sh <file-to-sign>
#
# Azure Trusted Signing occasionally throttles a single request when tauri
# signs many PEs per bundle (app exe, ghostty-vt.dll, WiX/NSIS helper DLLs) in
# quick succession, so retry with backoff. Endpoint/account/profile and the
# Azure SP creds are read from the environment (set on the bundle step). On
# total failure it dumps the signer's output, which tauri otherwise swallows.
set -uo pipefail

file="$1"
out=""
for attempt in 1 2 3 4 5; do
  if out=$(artifact-signing-cli -e "$TS_ENDPOINT" -a "$TS_ACCOUNT" -c "$TS_PROFILE" "$file" 2>&1); then
    exit 0
  else
    rc=$?
    echo "sign attempt $attempt failed for $file (exit $rc)"
  fi
  [ "$attempt" -lt 5 ] && sleep $((attempt * 5))
done
printf '%s\n' "$out"
echo "signing failed after 5 attempts: $file"
exit 1
