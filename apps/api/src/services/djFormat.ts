/**
 * Authenticated broadcaster wire formats.
 *
 * PCM is kept byte-for-byte compatible with previously deployed browser
 * clients. WebM/Opus is continuous, so each socket MUST begin with a new
 * MediaRecorder stream containing its own WebM header.
 */
export type DjAudioFormat = 'pcm_s16le' | 'webm_opus';

export function negotiateDjAudioFormat(value: unknown): DjAudioFormat | null {
  if (value === undefined || value === 'pcm_s16le') return 'pcm_s16le';
  if (value === 'webm_opus') return 'webm_opus';
  return null;
}

export function ffmpegInputArgs(format: DjAudioFormat): string[] {
  return format === 'webm_opus'
    ? ['-f', 'webm', '-i', 'pipe:0']
    : ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', 'pipe:0'];
}

export function validAudioFrame(format: DjAudioFormat, byteLength: number): boolean {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) return false;
  if (format === 'pcm_s16le') return byteLength <= 64 * 1024 && byteLength % 4 === 0;
  // WebM clusters are byte-oriented, NOT four-byte-aligned PCM frames.
  return byteLength <= 256 * 1024;
}

export function audioFormatDescription(format: DjAudioFormat): string {
  return format === 'webm_opus' ? 'WebM/Opus ~192 kbps stereo upload' : 'PCM 48kHz 16-bit stereo upload';
}
