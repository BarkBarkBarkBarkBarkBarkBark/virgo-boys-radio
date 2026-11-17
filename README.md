# Virgo Boys Radio — hi-fi live radio

Virgo Boys Radio provides a **one-tap website listening experience** with an optional Icecast/Liquidsoap public audio transport. Existing WebRTC broadcasting is retained as an **experimental development mode**, not the scalable public listener service.

## Architecture

- **Listener**: Next.js website or future native app → stable public **HTTPS Icecast listener URL** → audio playback and automatic reconnect. Set `NEXT_PUBLIC_STREAM_URL`; without this URL, the inherited WebRTC listening mode remains available for development.
- **DJ**: XDJ/mixer stereo line out → Scarlett/Steinberg audio interface → BUTT desktop encoder → authorized private live ingest. Run the three-second interface check on `/stream` before connecting BUTT.
- **Station**: Liquidsoap handles live DJ priority, MP3 playlist fallback and a configurable high-quality stereo output. It pushes **one program** to Icecast; Icecast distributes that output to listeners.
- **API**: Existing Fastify, SQLite and WebSocket services are retained for administrative features and legacy room compatibility. They are not yet authoritative for Icecast listener counts or program metadata.

## Developer setup

```bash
pnpm install
cp apps/api/.env.example apps/api/.env
cp apps/web/.env.local.example apps/web/.env.local
cp local_deploy.env.example local_deploy.env
docker compose -f local_deploy.yaml up --build
```

Set strong unique passwords in `local_deploy.env` (or use `pnpm local:install` to generate local credentials).

Local dev endpoints:
- Web: `http://localhost:3000`
- Public Icecast audio: `http://localhost:8000/radio.mp3`
- DJ ingest (LAN only): `http://localhost:8005/live`
- Fastify API: `http://localhost:3001`

Place MP3 fallback tracks in `media/library/`. The local Liquidsoap profile defaults to 320 kbps stereo MP3 output at 48 kHz. Configuring a higher listener limit does **not** by itself provide enough bandwidth for 1,000 listeners.

**Production requires a public HTTPS endpoint and secured remote DJ ingress.** Do not expose port 8005 with its default unencrypted development configuration. See [broadcast architecture](docs/high-fidelity-broadcast.md) and [TODO.md](TODO.md).

## Easy entry and diagnostic tools

- One Play button on the homepage and persistent bottom bar.
- "Test listening connection": browser audio reachability/decode probe, **not** a speed or fidelity certification.
- `/stream`: guided input device selection, approximately 3-second channel/level check, and private source setup instructions. It does not publish sound from the browser to Icecast.
- Existing `/stream` WebRTC broadcaster is explicitly labeled experimental when no public Icecast URL has been configured.

## Deploy

The existing `fly.toml` continues to deploy the Fastify API, **not** an Icecast origin or relay. The Next.js frontend can remain on Vercel. Provide `NEXT_PUBLIC_STREAM_URL=https://your-controlled-radio-host/radio.mp3` at web build time.

Keep Icecast source passwords and DJ passwords in private host configuration, never in `NEXT_PUBLIC_*`. See [TODO.md](TODO.md) for provider prerequisites, listener testing, source authentication and redundancy.
