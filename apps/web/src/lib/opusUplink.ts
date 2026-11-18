/**
 * Low-bandwidth, high-quality DJ uplink.
 *
 * One continuous WebM/Opus MediaRecorder stream per authenticated WebSocket.
 * A reconnect always creates a NEW recorder so FFmpeg gets a fresh WebM header.
 * Never drop an individual WebM blob: that could corrupt the remaining stream.
 */
export const OPUS_MIME = 'audio/webm;codecs=opus';
export const OPUS_AUDIO_BITRATE = 192_000;
export const OPUS_CHUNK_PERIOD_MS = 250;
export const OPUS_SOFT_BACKLOG_BYTES = 96 * 1024;
export const OPUS_HARD_BACKLOG_BYTES = 256 * 1024;
export const OPUS_MAX_CONGESTED_MS = 12_000;
const MAX_QUEUED_BLOBS = 12;

export type UplinkFormat = 'pcm_s16le' | 'webm_opus';
export type UploadPreference = 'auto' | 'pcm';

export function canRecordOpus(): boolean {
  try {
    return typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(OPUS_MIME);
  } catch {
    return false;
  }
}

export function preferredUplinkFormat(preference: UploadPreference, supported: boolean): UplinkFormat {
  return preference === 'auto' && supported ? 'webm_opus' : 'pcm_s16le';
}

export function opusQueueMustRestart(backlogBytes: number, congestionMs: number, queuedBlobs: number): boolean {
  return backlogBytes >= OPUS_HARD_BACKLOG_BYTES
    || (backlogBytes >= OPUS_SOFT_BACKLOG_BYTES && congestionMs >= OPUS_MAX_CONGESTED_MS)
    || queuedBlobs > MAX_QUEUED_BLOBS;
}

export type OpusUplink = { stop: () => void };

export function startOpusUplink(options: {
  stream: MediaStream;
  socket: WebSocket;
  onBuffer: (bytes: number) => void;
  onWarning: (message: string) => void;
  onFailure: (message: string) => void;
}): OpusUplink {
  const { stream, socket, onBuffer, onWarning, onFailure } = options;
  const recorder = new MediaRecorder(stream, {
    mimeType: OPUS_MIME,
    audioBitsPerSecond: OPUS_AUDIO_BITRATE,
  });

  let stopped = false;
  let congestedSince = 0;
  let pendingBlobs = 0;
  let ordered = Promise.resolve();

  const stop = () => {
    if (stopped) return;
    stopped = true;
    recorder.ondataavailable = null;
    recorder.onerror = null;
    if (recorder.state !== 'inactive') recorder.stop();
  };

  const interrupt = (reason: string) => {
    if (stopped) return;
    onFailure(reason);
    stop();
    if (socket.readyState === WebSocket.OPEN) {
      socket.close(4008, 'opus_uplink_queue_stalled');
    }
  };

  recorder.onerror = () => interrupt('Browser Opus encoder failed; reconnecting.');

  recorder.ondataavailable = (event: BlobEvent) => {
    if (stopped || !event.data.size) return;
    const blob = event.data;
    pendingBlobs += 1;
    if (pendingBlobs > MAX_QUEUED_BLOBS) {
      interrupt('Opus encoder chunks accumulated faster than they could be transmitted.');
      return;
    }

    // Blob.arrayBuffer() is asynchronous. Serialize conversions and sends to
    // preserve strict WebM byte order across individual MediaRecorder chunks.
    ordered = ordered.then(async () => {
      if (stopped || socket.readyState !== WebSocket.OPEN) return;
      const bytes = await blob.arrayBuffer();
      if (stopped || socket.readyState !== WebSocket.OPEN) return;

      if (bytes.byteLength > 256 * 1024) {
        interrupt('Opus chunk exceeded safe streaming size; reconnecting.');
        return;
      }

      const backlog = socket.bufferedAmount;
      onBuffer(backlog);
      const now = Date.now();
      if (backlog >= OPUS_SOFT_BACKLOG_BYTES) {
        if (!congestedSince) {
          congestedSince = now;
          onWarning('Opus upload temporarily congested; retaining encoded audio in order.');
        }
      } else if (backlog < OPUS_SOFT_BACKLOG_BYTES / 3) {
        congestedSince = 0;
      }
      const congestionMs = congestedSince ? now - congestedSince : 0;
      if (opusQueueMustRestart(backlog + bytes.byteLength, congestionMs, pendingBlobs - 1)) {
        interrupt('Opus upload backlog cannot recover without excessive latency; reconnecting.');
        return;
      }

      // A WebM chunk is already compressed. It MUST be sent intact.
      socket.send(bytes);
      onBuffer(socket.bufferedAmount);
    }).catch(() => interrupt('Could not send Opus audio; reconnecting.')).finally(() => {
      pendingBlobs -= 1;
    });
  };

  recorder.start(OPUS_CHUNK_PERIOD_MS);
  return { stop };
}
