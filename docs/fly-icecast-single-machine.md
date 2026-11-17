# Fly single-Machine Icecast pilot

**Status:** image and routing configuration are prepared in GitHub, but Icecast is NOT installed on the running Fly Machine until a new Fly image is built and deployed. The available Fly connection cannot run commands inside the existing Machine or deploy a new image.

This is a limited, opt-in pilot for direct DJ-to-Icecast streaming. It intentionally uses the existing app (wst-prt-radio), attached SQLite/songs volume and API hostname. No new billed Fly Machines are required.

## Architecture

- Fly HTTPS port 443 forwards to Caddy on container port 3001.
- Caddy forwards /radio.mp3 to Icecast on loopback 127.0.0.1:8000.
- All existing Fastify endpoints, including /health, /public/status, /admin and WebSocket /signal, forward to Fastify on container port 3002.
- Existing Vercel NEXT_PUBLIC_API_BASE_URL remains https://wst-prt-radio.fly.dev.
- Alpine Icecast and Caddy packages are baked into the Fly Docker image. The Fly root filesystem is otherwise ephemeral. There is no need for a dedicated public 8443 listener, which is incompatible with the existing shared IPv4 setup.

## Safely deploy

1. Confirm the existing database volume and backend are healthy; retain the old Fly image for rollback. Merge this PR after the Docker smoke job succeeds.
2. Deploy the root fly.toml and Dockerfile from the monorepo root using the Fly CLI:

   fly deploy --app wst-prt-radio --config fly.toml --remote-only

3. Icecast is intentionally DISABLED on the first deployment. Verify https://wst-prt-radio.fly.dev/health, /public/status, authenticated admin login and WebSocket behavior first.
4. Generate THREE independent 32-byte hex passwords locally with openssl rand -hex 32, and store them in a password manager. Set these as Fly application secrets: ICECAST_SOURCE_PASSWORD, ICECAST_ADMIN_PASSWORD, ICECAST_RELAY_PASSWORD. Also set ICECAST_ENABLED=true. Example mechanism: fly secrets set --app wst-prt-radio KEY=VALUE ...; supply values privately on your own machine. Do NOT copy these passwords into Vercel, GitHub or chat. Fly may restart its Machine when you change secrets.
5. Verify that https://wst-prt-radio.fly.dev/radio.mp3 returns a no-source error instead of a reverse-proxy error. That is expected before a DJ connects.
6. Configure an Icecast-compatible encoder (such as BUTT): host wst-prt-radio.fly.dev, port 443, TLS enabled, mount /radio.mp3, username source, and the private source password. Start a stereo, 320 kbps MP3 stream from your Scarlett or Steinberg input and confirm playback on a second device. If the encoder cannot negotiate a source upload through Caddy, test directly on a secure tunnel and revise the proxy before announcing the launch.
7. Only AFTER this test succeeds, configure Vercel NEXT_PUBLIC_STREAM_URL to https://wst-prt-radio.fly.dev/radio.mp3 and deploy the frontend again.

Do not treat a successful container build as proof that source ingest, client playback or long-running streaming is working. Also check actual outbound codec/bitrate, listener reconnections, API latency, memory and bandwidth usage.

## What this pilot does NOT provide

- Icecast does not create AutoDJ: there is no music fallback when the DJ disconnects. Liquidsoap integration remains a separate task.
- One 512 MB / one shared-CPU Fly Machine has not been capacity-tested for hundreds or 1,000 simultaneous 320 kbps listeners. Start with a conservative Icecast client cap (100 by default) and load test before increasing it.
- The browser broadcaster in /stream uses legacy WebRTC; it does not feed Icecast. Use BUTT or a compatible external source encoder.
- Icecast source, relay and admin secrets MUST remain private. Its internal admin/status pages are not publicly proxied.

## Rollback

If Fastify or Caddy has problems, redeploy the previous known-good Fly image/config while preserving the volume and secrets; do not delete or recreate the current database. Setting ICECAST_ENABLED=false disables only Icecast after the patched image is deployed but does not remove the Caddy proxy. Reverting the patch fully requires deploying the previous image.

## Verification gates

- Docker image builds with Icecast and Caddy installed.
- The local smoke test runs Fastify through Caddy on port 3001 and confirms the Icecast mount is reachable via Caddy.
- Public Fly HTTPS routes verified manually.
- Source upload and client playback verified with a real encoder.
- Realistic listener load test and failover exercise before public launch.
