#!/usr/bin/env bash
# Operator-only. One strong random capability per DJ; sharing this link grants
# broadcast access until you rotate DJ_INGEST_TOKEN. No secret is in Vercel.
set -euo pipefail
umask 077
command -v fly >/dev/null || { echo 'Fly CLI is required.' >&2; exit 1; }
command -v openssl >/dev/null || { echo 'OpenSSL is required.' >&2; exit 1; }
secret="$(openssl rand -hex 32)"
printf 'DJ_INGEST_TOKEN=%s\n' "$secret" | fly secrets import --app wst-prt-radio
printf '\nPRIVATE DJ LINK — share only with the authorized DJ:\n'
printf 'https://virgoboys.com/dj#token=%s\n' "$secret"
printf '\nRotate by running this script again. Rotating restarts the Fly app.\n'
unset secret
