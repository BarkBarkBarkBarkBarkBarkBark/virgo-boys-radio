/**
 * Best-effort station telemetry. Metadata only: no audio samples, URL tokens,
 * invite codes, cookies, microphone names, or account identifiers.
 * Browser reports are observational (not authoritative proof of network state).
 */
type Phase = 'idle' | 'connecting' | 'playing' | 'buffering' | 'error' | 'paused' | 'stopped' | 'checking' | 'verified' | 'warning' | 'unavailable';
type Role = 'listener' | 'monitor';
type Metadata = {
  phase?: Phase;
  details?: string;
  bufferedSeconds?: number;
  networkState?: number;
  readyState?: number;
  queueBytes?: number;
  droppedFrames?: number;
  delayMs?: number;
  matchPercent?: number;
};
const ids = new Map<Role, string>();
export function browserStationId(role: Role) {
  let id = ids.get(role);
  if (!id) {
    id = crypto.randomUUID().replace(/-/g, '');
    ids.set(role, id);
  }
  return id;
}
export function sendStationTelemetry(role: Role, event: string, metadata: Metadata = {}, audio?: HTMLAudioElement | null) {
  if (typeof window === 'undefined') return;
  let bufferedSeconds: number | undefined = metadata.bufferedSeconds;
  if (audio && audio.buffered.length) {
    try {
      bufferedSeconds = Math.max(0, audio.buffered.end(audio.buffered.length - 1) - audio.currentTime);
    } catch { /* A live HTTP stream may have no seekable/buffered timeline. */ }
  }
  const payload = JSON.stringify({
    clientId: browserStationId(role), role, event,
    ...metadata,
    ...(audio ? { readyState: audio.readyState, networkState: audio.networkState, bufferedSeconds } : {}),
  });
  // Keep user playback independent from diagnostics failures.
  void fetch('/api/telemetry', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true })
    .catch(() => undefined);
}
