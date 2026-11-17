# Virgo Boys Radio — production broadcast TODO

This checklist tracks **missing infrastructure and unverified requirements**. Adding a URL or raising a config limit is not a fidelity or capacity guarantee.


## Temporary Fly backend / branding

- [x] Connect the Vercel website to the existing `wst-prt-radio.fly.dev` Fastify API via `NEXT_PUBLIC_API_BASE_URL`.
- [x] Add `https://virgo-boys-radio.vercel.app` to the Fly `CORS_ALLOWED_ORIGINS` secret, preserving the original production site origins.
- [ ] Verify the live API's `/health`, `/public/status`, events and artists responses from the deployed Virgo website and in mobile Safari; CORS configuration alone does not prove reachability.
- [ ] Verify authenticated admin sign-in on Safari with the API on a separate fly.dev origin. Third-party cookie blocking may require a same-site reverse proxy or an API subdomain owned by the station.
- [ ] Decide whether to migrate the legacy Fly service name, database and `@virgo-boys-radio` internal package identifiers. These are not visible station branding and are intentionally left untouched to avoid breaking the running backend.
- [ ] Configure the production public HTTPS Icecast stream; `NEXT_PUBLIC_API_BASE_URL` is **not** an audio streaming URL.
- [ ] Do not migrate Fly's `SESSION_SECRET`, `ADMIN_USERS`, or DJ ingest passwords to Vercel. Only add server-side secrets there if a future trusted Vercel server feature specifically needs its own credential.

## External setup required before launch

- [ ] Choose an Icecast host (managed or self-hosted) with sustained 1,000-listener capacity at 320 kbps MP3, adequate egress (~320 Mbps payload plus overhead), no unanticipated usage caps, and a realistic reliability SLA. Confirm by testing rather than marketing claims.
- [ ] Provision a public **HTTPS** stream URL (e.g. `https://radio.example.com/radio.mp3`) and stable station-owned DNS; set `NEXT_PUBLIC_STREAM_URL` in the web deployment and rebuild it. The `radio.mp3` path is an example, not an existing endpoint.
- [ ] Provision a separate **private DJ ingest endpoint** (for Liquidsoap Harbor or a managed equivalent) and one-time/revocable source credentials. Set public **host, port, mount** via `NEXT_PUBLIC_BROADCAST_HOST`, `NEXT_PUBLIC_BROADCAST_PORT`, `NEXT_PUBLIC_BROADCAST_MOUNT`, but NEVER the password in any `NEXT_PUBLIC_*` env. Secure remote ingest with TLS/reverse proxy (plain port 8005 in Docker is LAN development only).
- [ ] Decide who may broadcast. For public site visitors, listening can be one tap; broadcasting must require authentication and scheduled/authorized DJ access to protect the station and unreleased music.
- [ ] Set production Liquidsoap and Icecast secrets; configure AutoDJ library, contribution codec, source priority, and fallback tracks. Validate local Docker config against Liquidsoap 2.3.3 before production rollout.
- [ ] Replace existing legacy WebRTC browser broadcaster if **one-tap browser-to-Icecast broadcasting** is mandatory. Existing `/stream` WebRTC host is not wired to public Icecast. This requires a browser audio ingest service, stable stereo encoder, low-overhead transport, backend bridge into Liquidsoap, authentication, and DJ arbitration. The current page offers an input device check and BUTT setup, not browser-to-Icecast broadcasting.

## Reliability / audio quality sign-off

- [ ] Record a reference test through XDJ → Scarlett/Steinberg line inputs → BUTT → live Harbor/ingest → Liquidsoap → Icecast → web/mobile playback. Validate true stereo channels, no browser AGC/echo removal, good headroom, actual codec/bitrate, absence of clipping, and a listening ABX comparison on difficult dubstep excerpts.
- [ ] Run 1,000-concurrent-listener load tests with headroom and measure actual bandwidth, startup time, server queues, playback stalls, restarts, and cost. `ICECAST_MAX_LISTENERS=1000` only sets a limit; it does not create bandwidth or relay servers.
- [ ] Provision independent relay/backup origin for important events, ensure adequate capacity after one failure, and rehearse DJ disconnects plus origin/relay failover.
- [ ] Add an API to report real station status, listener count, and bitrate from the production stream server. Legacy WebRTC room counts and random local song labels must not be reused for Icecast statistics.
- [ ] Add live monitoring: outbound bitrate, packet/connection errors, stream availability, audio silence/clipping, reconnect rates, listener buffering, alerts and operational runbook.
- [ ] Configure geographically appropriate relay locations or HLS+CDN if player buffering needs become more deterministic. HTML `<audio>` with a live MP3 mount does **not** guarantee a fixed 30-second buffer.
- [ ] Verify HTTPS, media decoding and background-playback behavior across Safari iOS, Chrome Android, desktop browsers, and native apps; include cellular handovers and transient connectivity outages.
- [ ] Review artist rights, consent and visibility of unreleased tracks. Public streams can be recorded; streaming is not copy protection.

## Next product increments

- [ ] Add a deliberate test mode that reports receive throughput with real CORS-enabled data samples, server-side ingest health, and a broadcaster-to-listener end-to-end loopback. The current **Test listening connection** verifies media reachability/decodability only, not throughput or audio fidelity.
- [ ] Native iOS/Android apps sharing the production stream URL and API; background audio, lock-screen playback, interruption handling, and metadata.
- [ ] Optional modern Opus 192–256 kbps output and compatibility fallback; ABX compare at low and high bitrates.
- [ ] Store lossless artist masters securely, avoid transcoding a low-bitrate MP3 into another lossy MP3, add true-peak QC; keep sensitive masters out of public code/history.
- [ ] Finalize branding (repo currently inherited `Virgo Boys Radio` labels from previous project), DNS and legal policies before public launch.
## Fly single-Machine Icecast pilot

- [x] Prepare Docker image with Caddy and Icecast; keep existing Fastify API public hostname unchanged.
- [x] Add loopback-only Icecast config and Caddy path routing for HTTPS /radio.mp3.
- [x] Create a Docker container smoke workflow to test the API and Icecast mount.
- [ ] **Deploy this image to Fly**. GitHub commits do not install packages on a running Machine, and this ChatGPT Fly connection does not authorize Machine execution or image deployment.
- [ ] Set strong ICECAST_SOURCE_PASSWORD, ICECAST_RELAY_PASSWORD, ICECAST_ADMIN_PASSWORD and ICECAST_ENABLED=true via Fly secrets after initial API health check.
- [ ] Test actual HTTPS PUT source ingest from BUTT (320 kbps stereo) and listen from another device/network.
- [ ] Set NEXT_PUBLIC_STREAM_URL=https://wst-prt-radio.fly.dev/radio.mp3 in Vercel only after live source playback works.
- [ ] Build a Liquidsoap AutoDJ fallback and repeat load tests with API and stream sharing 512 MB RAM/1 CPU.
