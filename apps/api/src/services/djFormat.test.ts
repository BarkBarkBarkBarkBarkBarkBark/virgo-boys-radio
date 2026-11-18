import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  audioFormatDescription, ffmpegInputArgs, negotiateDjAudioFormat, validAudioFrame,
} from './djFormat.js';

test('legacy authentication defaults to PCM and rejects unknown encodings', () => {
  assert.equal(negotiateDjAudioFormat(undefined), 'pcm_s16le');
  assert.equal(negotiateDjAudioFormat('pcm_s16le'), 'pcm_s16le');
  assert.equal(negotiateDjAudioFormat('webm_opus'), 'webm_opus');
  assert.equal(negotiateDjAudioFormat('opus'), null);
  assert.equal(negotiateDjAudioFormat(['webm_opus']), null);
  assert.match(audioFormatDescription('webm_opus'), /192 kbps/);
});

test('WebM accepts byte-aligned recorder chunks; legacy PCM requires stereo samples', () => {
  assert.equal(validAudioFrame('pcm_s16le', 8192), true);
  assert.equal(validAudioFrame('pcm_s16le', 8191), false);
  assert.equal(validAudioFrame('pcm_s16le', 0), false);
  assert.equal(validAudioFrame('pcm_s16le', 65_536), true);
  assert.equal(validAudioFrame('pcm_s16le', 65_540), false);
  assert.equal(validAudioFrame('webm_opus', 17), true);
  assert.equal(validAudioFrame('webm_opus', 256 * 1024), true);
  assert.equal(validAudioFrame('webm_opus', 256 * 1024 + 1), false);
});

const available = spawnSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0;

test('FFmpeg decodes a fragmented, continuous WebM/Opus uplink to stereo 48k PCM', {
  skip: !available && 'FFmpeg not installed on this runner',
}, async () => {
  // This is the actual demuxing format the Fly FFmpeg process receives.
  const encoded = spawnSync('ffmpeg', [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'sine=frequency=443:sample_rate=48000:duration=1.4',
    '-ac', '2', '-c:a', 'libopus', '-b:a', '192k', '-f', 'webm', 'pipe:1',
  ], { maxBuffer: 2 * 1024 * 1024 });
  assert.equal(encoded.status, 0, encoded.stderr.toString());
  assert.ok(encoded.stdout.length > 8000);

  const decoder = spawn('ffmpeg', [
    '-hide_banner', '-nostdin', '-loglevel', 'error',
    ...ffmpegInputArgs('webm_opus'),
    '-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1',
  ]);
  const decoded: Buffer[] = [];
  const errors: Buffer[] = [];
  decoder.stdout.on('data', (chunk: Buffer) => decoded.push(chunk));
  decoder.stderr.on('data', (chunk: Buffer) => errors.push(chunk));

  // Chunk boundaries intentionally do not align to WebM/Opus frame sizes.
  for (let offset = 0; offset < encoded.stdout.length; offset += 137) {
    decoder.stdin.write(encoded.stdout.subarray(offset, offset + 137));
  }
  decoder.stdin.end();

  const code = await new Promise<number | null>((resolve, reject) => {
    decoder.once('error', reject);
    decoder.once('close', resolve);
  });
  assert.equal(code, 0, Buffer.concat(errors).toString());
  const output = Buffer.concat(decoded);
  assert.ok(output.length > 200_000, 'Should decode over one second of stereo 48kHz PCM');
  assert.equal(output.length % 4, 0);
});
