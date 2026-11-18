# Virgo Boys Radio — broadcast operations

The private station dashboard is at **https://virgoboys.com/admin**. A short, operator-chosen password is stored only as the Fly `OPS_ADMIN_PASSWORD` secret; do not commit it or send it to a DJ. Vercel signs an 8-hour HttpOnly, SameSite=Strict session, and the Fly service enforces a limit of five admin password attempts per five minutes.

## Release steps

1. Merge the tested admin-observability PR.
2. Confirm `OPS_ADMIN_PASSWORD` and `OPS_SHARED_SECRET` are set on Fly and that matching `OPS_SHARED_SECRET` and independent `OPS_SESSION_SECRET` exist on Vercel. Never paste these secrets into the website or GitHub.
3. Vercel deploys automatically from `main`. Confirm the release status is READY.
4. From the root of the current local Git clone, deploy the Fly backend:

   ```bash
   git switch main
   git pull --ff-only
   fly deploy . --app wst-prt-radio --config fly.toml --remote-only
   fly status --app wst-prt-radio
   curl -fsS https://wst-prt-radio.fly.dev/health
   ```

5. Open /admin, sign in, verify Icecast status and server process metrics populate. The existing `/data/wstprtradio.db` persists invitations and completed broadcast sessions.
6. Create a DJ invitation named `Audio reliability test`, 2-hour expiry; copy the magic link or the 12-character passcode.
7. Open the DJ booth on a computer (wired network preferred). Select built-in test audio and Go Live. Listen on a second device using cellular data.
8. Leave the test broadcasting for **at least 15 minutes**. Watch metrics every four seconds: source connected, listeners, input throughput (~1536 kbps at 48 kHz stereo PCM), last audio packet age, FFmpeg input queue, process RSS and uptime.
9. Disconnect intentionally. Confirm a new session appears under Recent disconnects with a duration, data volume and reason. Repeat with an audio interface or permitted browser-tab source.

## Reading the metrics

- **DJ uplink CONNECTED but Icecast NO SOURCE:** the browser authenticated but the FFmpeg -> Icecast publisher has not established the mount. Check the encoder process, source password and local Icecast logs.
- **Uplink input throughput around 1536 kbps:** 48 kHz * 2 channels * 16 bits/sample. This measures raw browser upload, not listening bitrate. Icecast reports the compressed 320 kbps output when metadata is available.
- **Last audio packet age climbs above several seconds:** browser media graph halted or stalled. Common causes include background-tab throttling, screen-share permission ending, device disconnection, OS sleep, or network interruption.
- **FFmpeg queue growing steadily:** encoder or upstream Icecast socket is not consuming the PCM stream quickly enough; at the guardrail threshold the backend disconnects intentionally rather than building unlimited delay.
- **websocket_close_1006:** abnormal network/socket close; browser code and network conditions must be examined. 1006 is not a WebSocket close frame sent by a peer.
- **ffmpeg_exit_N or ffmpeg_spawn_error:** backend encoder failed (codec, source occupancy, permissions, process crash, or Icecast source rejection). Try a local reference feed and inspect Fly service logs.
- **server_restarted_or_crashed:** Fly process was restarted or died without a clean WebSocket close. Check Fly machine events, resource limits and deploy activity.
- **process memory / uptime changes abruptly:** possible Fly restart. A running 512 MB shared machine has not yet been proven reliable under large listener load.

## Access management

- **Magic link:** copy from dashboard and send privately; the token is in the browser URL fragment and is never included in the initial HTTPS page request.
- **Passcode:** share the 12-character generated code; DJ types it at `https://virgoboys.com/stream`. Codes are random, not human-chosen.
- Access is valid for the selected expiry. Tokens and passcodes are SHA-256 hashed at rest. They are only displayed once when generated.
- Revoking access prevents a *new* connection; it does not terminate an already-established live session. Stop the session separately if immediate removal is required.
- Legacy CLI-created `DJ_INGEST_TOKEN` links remain accepted for compatibility and should be rotated if ever exposed.

## Security notes

The user-selected short admin password is suitable only for tightly scoped testing and should be replaced with a long unique secret before inviting external artists. Fastify login rate limiting helps, but it is not a substitute for a strong password or MFA. Anyone with an active magic link or passcode can broadcast until expiry or revocation. Do not post links publicly.

The separate `/admin/legacy` editor is preserved; its old cross-origin Fly login may need separate cookie/proxy repair. The new `/admin` operations dashboard deliberately uses its own first-party session and server-to-server authenticated API.

## Rollback

If the new Fly backend fails health or destabilizes broadcasting, deploy the previous known-good Fly image from Fly releases while preserving the existing `/data` volume and all Fly secrets. Do not delete the Fly app or database.
