# Phone/API audio quality self-test

The private station admin dashboard contains **Audio quality self-test**, under the connection inspector. It runs a short *synthetic* signal through the audio codecs on Fly, then displays measurable loudness and spectral changes.

## Phone steps

1. End any active DJ broadcast; the test refuses to run while the live Icecast mount or browser broadcaster is active.
2. Sign in at https://virgoboys.com/admin on your phone.
3. Expand **Audio quality self-test**, tap **Run audio self-test**, and view the two pipeline reports.
4. Optionally listen to each MP3 test tone with headphones. The phone's built-in speaker cannot reliably reproduce 56 Hz sub-bass.
5. Tap **Copy measurements as JSON** to share numerical findings without including the synthesized audio.

## API usage

The existing authenticated web admin same-origin endpoint is **POST /api/ops/audio-self-test**. It requires an existing signed admin browser session and the same-origin POST protection. The server-side proxy uses the pre-existing private \`OPS_SHARED_SECRET\` to call the Fly endpoint **POST /ops/audio-self-test**. Do not expose this secret in browser code or public documentation. The endpoint is rate limited to 2 calls every 5 minutes and allows only one concurrent test.

## What the offline diagnostic does

It synthesizes four seconds of known, unclipped 48-kHz stereo PCM containing:
- 56 Hz low-frequency (sub-bass) tone on both channels
- 440 Hz left / 880 Hz right (separate midrange test components)
- 7200 Hz treble tone on both channels

Two independent FFmpeg paths are tested in memory, without writing files or touching the live mount:

1. **PCM → 320 kbps MP3 → PCM**
2. **PCM → 192 kbps WebM/Opus → 320 kbps MP3 → PCM**

Each is compared to the generated input using middle-of-signal 250-ms windows. The endpoint measures:

- Overall RMS gain difference in dB
- Excess level variation ("pumping") of a steady signal in dB
- Amplitude deviation at 56 Hz and 7.2 kHz
- Stereo channel differential gain and relative 56 Hz sub-bass phase/polarity
- Clipping fraction and output peak level

The admin dashboard reports pass/warning thresholds, raw measurements, and a short playable MP3 reference for each pipeline.

## Crucial limits

This is a **server-codec-only** test. A clean result makes a serious Fly codec gain/bass defect less likely, but does **not** establish that the real DJ capture path is healthy. It does **not** inspect input-device processing, capture AGC, browser MediaRecorder implementation, WebSocket audio timing, live Icecast delivery, iPhone Safari decoding, or the listening device's speakers.

If these server tests pass while real broadcasts still pump in both PCM and Opus, next investigate the actual DJ input: verify \`MediaStreamTrack.getSettings()\` and Windows/audio-device enhancement settings, stereo polarity and possible clipping. The existing live Test tone source is a separate way to bypass the microphone/interface path and test the live transport.
