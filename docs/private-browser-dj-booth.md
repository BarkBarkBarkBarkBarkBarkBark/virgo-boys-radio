# Private no-install DJ booth

## DJ experience

Send the invited DJ a private link. They open it in desktop Chrome, Firefox, Edge or Safari over HTTPS, choose a USB stereo input, allow microphone access, check L/R levels, and click Go Live. They do **not** install BUTT or see an Icecast password. A mixing console with analog outputs still needs a USB audio interface.

The booth at `/dj` uses a Web Audio AudioWorklet to send 48 kHz signed 16-bit stereo PCM over a protected WebSocket to the existing Fastify API on Fly. Server-side FFmpeg encodes one **320 kbps stereo MP3** stream into Icecast mount `/radio.mp3`. Icecast owns distribution to listeners; the DJ uploads only once.

## Operator setup — not ready until deployed and tested

1. Ensure existing Fly Icecast installation is running, configured with ICECAST_SOURCE_PASSWORD and ICECAST_ENABLED=true.
2. Deploy this PR's updated Fly Docker image (adds Alpine ffmpeg, /dj/pcm route) using the same Fly command as before:
   `fly deploy --app wst-prt-radio --config fly.toml --remote-only`
3. Confirm public API /health returns 200 and Caddy proxies WebSocket upgrades.
4. Run `bash scripts/create-dj-link.sh` **locally** to rotate a 256-bit private invitation token. It uses stdin via `fly secrets import` and prints the link once. Fly restarts upon changing a secret, so generate invitations **before** the show.
5. Send the printed private /dj#token=... link to the DJ by a private trusted channel. A copied link can be reused while the token remains valid; this is a deliberately simple pilot, not a short-lived or single-use invitation service.
6. Connect a known stereo line-level source. Click Go Live, allow microphone permission, inspect both L/R meters, and confirm a second device can actually listen at `https://wst-prt-radio.fly.dev/radio.mp3`. The booth's transmitting status confirms upload, **not** audience playback, audio fidelity or codec integrity.
7. Once verified, configure the website's `NEXT_PUBLIC_STREAM_URL` to that verified HTTPS endpoint and redeploy Vercel, then test one-tap listening on Wi-Fi and cellular.

## Security and reliability

- Source password and FFmpeg credentials remain exclusively on Fly, never in the browser or Next.js bundle.
- The browser capability is a 64-hex-character token delivered in a URL **fragment**, so it is not included in HTTP requests. Whoever possesses that private link can broadcast until you rotate it; treat it as a password.
- WebSocket authentication checks the allowed Origin and performs constant-time token comparison; only one session can transmit per Fly process. The browser must supply the credential in the initial WebSocket message.
- The backend rejects malformed frames and shuts the encoder down on disconnect or excessive backpressure. A physical wired network and dedicated USB interface are recommended.
- Admin endpoints must require session authentication; the previous bypass has been removed in this PR. Cross-site cookies between vercel.app and fly.dev can still be blocked on Safari; verify admin login separately.
- Server logs must never include the Icecast source password or raw FFmpeg URL.
- On network interruption, browser refresh or Fly restart, the DJ must reconnect. There is no automatic failover; a Liquidsoap AutoDJ backup is a separate requirement.
- The 512 MB shared Fly instance is NOT tested for 1,000 listeners. Load-test, monitor, and add relays before any large event.
- This is an initial architecture, not a verified concert-grade solution. Perform a real source-to-listener test before inviting outside talent.

## Rollback

You can switch the guest to standalone BUTT with the existing private Icecast source credentials. Do not modify or delete the /data volume. Revert this PR and redeploy the previous Fly image if the API is affected.
