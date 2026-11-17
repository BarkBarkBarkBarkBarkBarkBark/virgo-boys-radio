# High-fidelity broadcast design

## Goal

Make **listening one tap** while delivering a stable, high-quality stereo radio stream to roughly 1,000 concurrent listeners on web and, eventually, native apps. Listeners do not need microphones, accounts or WebRTC peer connections.

## Signal path

1. DJ: XDJ or mixer stereo line out → Scarlett/Steinberg interface, appropriate gain staging, no clipping.
2. Encoder: BUTT on DJ computer; choose true stereo and a high-quality contribution codec. Prefer uncompressed/FLAC contribution if available and uplink is reliable; avoid transcoding an already lossy low-bitrate file multiple times.
3. Ingest: secure private stream to Liquidsoap's live Harbor endpoint. The Docker example binds port 8005 **for trusted LAN development only**; production needs TLS-protected ingest, authorization, and key rotation.
4. Station: Liquidsoap selects live DJ when available and automatically falls back to a managed playlist. It outputs a single encoded program to Icecast.
5. Origin/distribution: Icecast with a 320 kbps MP3 stereo compatibility stream; optional efficient Opus output after device tests. For 1,000 listeners at 320 kbps, budget at least 320 Mbps of audio payload and network headroom, plus origin/relay failover.
6. Listener: web `<audio>` or native player, using a stable station-owned HTTPS audio URL. Browser connection testing uses media loading/decoding and is not a bitrate or ABX test.

## Why Icecast

Icecast distributes the same encoded stream to all listeners; it does not force the DJ to upload one WebRTC connection per listener. Existing WebRTC guest sessions may be retained as a separate interactive experience, but should not pretend to feed the public Icecast audience.

The Next.js web player uses `NEXT_PUBLIC_STREAM_URL` to select Icecast playback; a missing/invalid URL preserves the old WebRTC implementation so deployments are not broken until the streaming host exists.

## Local operation

```bash
pnpm local:install
```

The installer can generate source credentials in `local_deploy.env`; they must never be committed to Git. Send the DJ contribution to `/live` on port 8005 through a suitable encoder. Liquidsoap alone owns the listener mount `/radio.mp3` on Icecast port 8000.

The local station profile currently outputs **320 kbps stereo MP3** (48 kHz), with a playlist fallback from `media/library`. The public listener mount, live contribution mount, and source passwords are intentionally separate.

## Connection tests

- Browser listening probe: try loading the configured public station stream. Passing indicates the browser received decodable media; it does not prove 320 kbps, full stereo or continuous reliable delivery.
- DJ interface probe: request a stereo input with speech processing disabled and measure approximate channel peaks over three seconds. Device channel count/sample rate values are best effort; this is not an end-to-end ingest verification.
- Production QA still requires full-path reference recordings, verified codec/bitrate on origin, meaningful stereo tests, multi-device playback, and stress testing at 1,000 listeners.

## Operational deployment blockers

- Obtain a managed or self-hosted Icecast service and validate listener traffic and transfer limits.
- Set up HTTPS listening URL and encrypted/authenticated DJ ingest. Never publish source passwords via the web bundle.
- Set up real audio stream status and monitoring; legacy Fastify WebRTC metadata is **not** Icecast truth.
- Add relay redundancy and test failure of broadcaster, station encoder, origin and relay.
- Consider HLS/CDN only if deterministic multi-segment buffering and distribution economics justify it. A live MP3 element cannot guarantee a specific 30-second buffer.
- Add native background audio support separately. Web UI alone does not imply native iOS/Android background playback.
- Test unreleased music permissions and protection expectations. Any public stream can be recorded.

See [TODO.md](../TODO.md) for sign-off and procurement tasks.
