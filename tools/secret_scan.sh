#!/usr/bin/env bash
# Secret scan gate (U00). Exit 0 = clean, 1 = finding, 2 = usage error.
# Scans the given directory (default: repo root) for credentials that must never be committed:
# App Check debug tokens, Google API keys outside the public firebase config, service-account keys, private keys.
set -uo pipefail
ROOT=${1:-"$(cd "$(dirname "$0")/.." && pwd)"}
[ -d "$ROOT" ] || { echo "usage: $0 [dir]" >&2; exit 2; }
hits=0
report() { echo "SECRET: $1"; hits=$((hits+1)); }
EXCL=(--exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude=secret_scan.sh --exclude-dir=secret_scan)
while IFS= read -r l; do report "$l"; done < <(grep -rnIE "${EXCL[@]}" 'FIREBASE_APPCHECK_DEBUG_TOKEN[[:space:]]*=[[:space:]]*["'"'"'][0-9a-fA-F-]{20,}' "$ROOT")
while IFS= read -r l; do report "$l"; done < <(grep -rnIE "${EXCL[@]}" -- '-----BEGIN ([A-Z]+ )?PRIVATE KEY-----' "$ROOT")
while IFS= read -r l; do report "$l"; done < <(grep -rnIE "${EXCL[@]}" '"type"[[:space:]]*:[[:space:]]*"service_account"' "$ROOT")
# API keys are allowed only in the public web config file (Firebase web apiKey is an identifier, not a secret).
while IFS= read -r l; do report "$l"; done < <(grep -rnIE "${EXCL[@]}" --exclude=firebase-config.public.ts 'AIza[0-9A-Za-z_-]{35}' "$ROOT")
if command -v gitleaks >/dev/null 2>&1 && [ -d "$ROOT/.git" ]; then
  gitleaks detect --no-banner --redact -s "$ROOT" >/dev/null 2>&1 || report "gitleaks reported findings in git history (run: gitleaks detect -s $ROOT)"
fi
echo "secret_scan: $hits finding(s) in $ROOT"
[ "$hits" -eq 0 ]
