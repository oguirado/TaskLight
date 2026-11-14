#!/usr/bin/env bash
# Oracle for U00: the scanner must FAIL on planted fakes and PASS on a clean tree.
set -u
HERE=$(cd "$(dirname "$0")" && pwd); SCAN="$HERE/../../tools/secret_scan.sh"
T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
fail=0
mkdir -p "$T/clean"; echo 'export const x = 1;' > "$T/clean/a.ts"
"$SCAN" "$T/clean" >/dev/null || { echo "FAIL clean tree flagged"; fail=1; }
plant() { d="$T/$1"; mkdir -p "$d"; printf '%s\n' "$2" > "$d/f.ts"; if "$SCAN" "$d" >/dev/null; then echo "FAIL not caught: $1"; fail=1; else echo "ok caught: $1"; fi; }
plant debug_token "self.FIREBASE_APPCHECK_DEBUG_TOKEN = \"$(printf '%s' 0123abcd-0000-4000-8000-0123456789ab)\";"
plant private_key "-----BEGIN PRIVATE KEY-----"
plant service_account '{"type": "service_account", "project_id": "x"}'
plant api_key "const k = \"AIza$(printf 'A%.0s' $(seq 35))\";"
exit $fail
