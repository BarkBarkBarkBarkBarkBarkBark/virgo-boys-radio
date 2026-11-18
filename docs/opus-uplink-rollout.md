# Opus DJ uplink: deployment and validation

## What changes

- The DJ browser requests `audioFormat: "webm_opus"` on the existing authenticated `/dj/pcm` WebSocket when its `MediaRecorder` supports `audio/webm;codecs=opus`.
- Web Audio produces stereo samples into `MediaStreamAudioDestinationNode`. A fresh `MediaRecorder` emits a continuous WebM/Opus byte stream, requested at 192,000 bits/s, with 250-ms `dataavailable` intervals. Individual blobs are **not standalone WebM files**.
- Fly negotiates `audioFormat` in its `ready` reply. FFmpeg uses `-f webm -i pipe:0` to decode the upload and continues publishing **320-kbps stereo MP3** to the existing Icecast `/radio.mp3` mount.
- The listener and iPhone continue using the native browser MP3 player; no JS client decoder or new URL is required.
- Previously deployed browsers that send no `audioFormat` continue using 48-kHz, 16-bit stereo PCM. A new browser connecting to older Fly (no format in `ready`) also falls back to PCM rather than corrupting the server input.

## Why WebM chunks cannot be dropped

Unlike raw PCM, WebM is a continuous container containing a stream header and time-coded audio clusters. Dropping a random chunk corrupts continuity and can break demuxing. The client transmits all blobs in original order. After unrecoverable congestion it terminates and reconnects with a **new recorder**, so the new FFmpeg instance always receives a fresh container header.

The browser uses bounded queues. A small transient backlog is tolerated; a queue of 256 KiB, excessive blob conversion backlog, or 12 seconds of sustained 96-KiB congestion triggers a reconnect. Backpressure events remain visible in the Connection Inspector.

## Phone-only production deployment

1. Merge the verified PR into `main` (Vercel deploys the browser changes).
2. While no one is broadcasting, visit GitHub Actions → **Deploy Icecast on existing Fly app** → **Run workflow** → `main`. The existing GitHub repository secret `FLY_API_TOKEN` authorizes the workflow.
3. Watch the workflow complete and verify Fly `/health`.
4. Open the private DJ booth on an authorized site origin. Use Connection details → Broadcast upload → **Automatic — Opus when supported**.
5. Start an actual music broadcast from the same work network previously exhibiting WebSocket 4008. Open the station on an iPhone over cellular.
6. In Admin → Connection Inspector, confirm the DJ session's format, average upload throughput and peak browser queue; compare to listener waiting/stalled/errors and decoded stream verification.

Expected approximate data rate: **Opus 192 kbps (~24 KB/s)** vs PCM **1536 kbps (~192 KB/s)**, plus transport overhead. `MediaRecorder`'s requested bitrate is not guaranteed to be exact.

## Rollback and limits

The DJ Connection details selector allows **Uncompressed PCM** without redeploying. The Opus route only changes **DJ → Fly** bandwidth. It does not repair corporate WebSocket filtering, Icecast mount disconnections, iOS autoplay policy, or listener recovery. If audio still drops, compare timestamps of upload backpressure, encoder output errors, and iPhone media-element state events before changing more limits.

The Fly app has one running machine, so a production deploy can interrupt an on-air show. Do not attempt an on-air deploy. The current silent listener fingerprint monitor continues verifying actual music, not the fidelity of the intermediate codec.
