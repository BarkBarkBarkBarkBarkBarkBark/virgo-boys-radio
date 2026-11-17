#!/bin/sh
set -eu

# Keep the existing external API URL; Fastify now binds :3002 behind Caddy.
if [ "${PORT:-3002}" != "3002" ]; then
  echo "Fastify must bind port 3002 behind Caddy" >&2
  exit 1
fi

icecast_pid=""
if [ "${ICECAST_ENABLED:-false}" = "true" ]; then
  : "${ICECAST_SOURCE_PASSWORD:?Set ICECAST_SOURCE_PASSWORD in Fly secrets first}"
  : "${ICECAST_ADMIN_PASSWORD:?Set ICECAST_ADMIN_PASSWORD in Fly secrets first}"
  : "${ICECAST_RELAY_PASSWORD:?Set ICECAST_RELAY_PASSWORD in Fly secrets first}"
  : "${ICECAST_HOSTNAME:=wst-prt-radio.fly.dev}"
  : "${ICECAST_MAX_LISTENERS:=100}"

  # These values are inserted in XML: require long, XML-safe secrets.
  for key in ICECAST_SOURCE_PASSWORD ICECAST_ADMIN_PASSWORD ICECAST_RELAY_PASSWORD; do
    value="$(printenv "$key")"
    case "$value" in
      *[!a-zA-Z0-9_-]*|'') echo "Invalid $key: generate a long random hex password" >&2; exit 1 ;;
    esac
    if [ "${#value}" -lt 24 ]; then echo "$key must be at least 24 characters" >&2; exit 1; fi
  done

  mkdir -p /tmp/icecast-logs
  chown node:node /tmp/icecast-logs
  umask 077
  envsubst < /app/infra/fly/icecast.xml.template > /tmp/virgo-icecast.xml
  chown node:node /tmp/virgo-icecast.xml

  # No public Icecast port: Caddy proxies only the /radio.mp3 mount.
  su -s /bin/sh node -c "exec icecast -c /tmp/virgo-icecast.xml" &
  icecast_pid=$!
  echo "Icecast enabled on 127.0.0.1:8000"
else
  echo "Icecast disabled; existing API remains active"
fi

# Fly HTTPS :443 -> Caddy internal :3001 -> Fastify :3002 or Icecast :8000.
caddy run --config /app/infra/fly/Caddyfile --adapter caddyfile &
proxy_pid=$!

node /app/apps/api/dist/index.js &
api_pid=$!

shutdown() {
  trap - INT TERM
  kill "$api_pid" "$proxy_pid" 2>/dev/null || true
  if [ -n "$icecast_pid" ]; then kill "$icecast_pid" 2>/dev/null || true; fi
  wait "$api_pid" 2>/dev/null || true
  wait "$proxy_pid" 2>/dev/null || true
  if [ -n "$icecast_pid" ]; then wait "$icecast_pid" 2>/dev/null || true; fi
}
trap shutdown INT TERM

set +e
wait "$api_pid"
status=$?
set -e
shutdown
exit "$status"
