import assert from 'node:assert/strict';
import test from 'node:test';
import {
  OPUS_AUDIO_BITRATE, OPUS_HARD_BACKLOG_BYTES,
  OPUS_SOFT_BACKLOG_BYTES, OPUS_MAX_CONGESTED_MS,
  opusQueueMustRestart, preferredUplinkFormat,
} from './opusUplink';

test('Opus is automatic on compatible browsers, PCM fallback remains available', () => {
  assert.equal(preferredUplinkFormat('auto', true), 'webm_opus');
  assert.equal(preferredUplinkFormat('auto', false), 'pcm_s16le');
  assert.equal(preferredUplinkFormat('pcm', true), 'pcm_s16le');
  assert.equal(OPUS_AUDIO_BITRATE, 192000);
});

test('Opus retains recoverable congestion but restarts before unbounded delay', () => {
  assert.equal(opusQueueMustRestart(OPUS_SOFT_BACKLOG_BYTES, 1000, 1), false);
  assert.equal(opusQueueMustRestart(OPUS_SOFT_BACKLOG_BYTES - 1, 20_000, 1), false);
  assert.equal(opusQueueMustRestart(OPUS_SOFT_BACKLOG_BYTES, OPUS_MAX_CONGESTED_MS, 1), true);
  assert.equal(opusQueueMustRestart(OPUS_HARD_BACKLOG_BYTES, 0, 1), true);
  assert.equal(opusQueueMustRestart(0, 0, 13), true);
  assert.equal(opusQueueMustRestart(0, 0, 12), false);
});
