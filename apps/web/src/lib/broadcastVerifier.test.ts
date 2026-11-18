import assert from 'node:assert/strict';
import test from 'node:test';
import { compareFingerprints, findBroadcastMatch } from './broadcastVerifier';

const makeFrame = (i: number, timeMs = i * 100) => ({
  timeMs,
  // Independent time-varying frequency bands approximate a stereo music mix.
  spectrum: Array.from({ length: 10 }, (_, band) =>
    -54 + 15 * Math.sin(i * (0.16 + band * 0.012) + band * 1.4)
      + 7 * Math.cos(i * 0.43 + band * 0.71)),
  leftRms: 0.12,
  rightRms: 0.1,
  leftPeak: 0.4,
  rightPeak: 0.35,
});

test('identifies a lossy-encoded music passage returning several seconds later', () => {
  const input = Array.from({ length: 180 }, (_, i) => makeFrame(i));
  const output = input.slice(100, 160).map((frame, i) => ({
    ...frame,
    timeMs: frame.timeMs + 4700,
    // Small independent frequency-domain changes simulate lossy encoding.
    spectrum: frame.spectrum.map((value, band) => value + 0.8 * Math.sin(i * 1.7 + band)),
  }));
  const result = findBroadcastMatch(input, output);
  assert.ok(result, 'A correlated public stream should be detected');
  assert.ok(result.score > 0.9, 'MP3-like spectral changes should still correlate');
  assert.equal(result.delayMs, 4700);
});

test('unrelated live audio does not receive a verified result', () => {
  const input = Array.from({ length: 180 }, (_, i) => makeFrame(i));
  const unrelated = Array.from({ length: 60 }, (_, i) => ({
    ...makeFrame(i + 300, i * 100 + 3000),
    spectrum: Array.from({ length: 10 }, (_, band) =>
      -56 + 14 * Math.cos(i * (0.83 + band * 0.05) + band)),
  }));
  const result = findBroadcastMatch(input, unrelated);
  assert.ok(!result || result.score < 0.64, 'A different recording must not pass');
});

test('steady tones cannot produce a timed correlation or fake green status', () => {
  const constant = Array.from({ length: 50 }, (_, i) => ({
    ...makeFrame(i),
    spectrum: Array.from({ length: 10 }, (_, band) => -50 - band * 2),
  }));
  assert.equal(compareFingerprints(constant, constant).bands, 0);
  assert.equal(compareFingerprints(constant, constant).score, 0);
});

test('silent listener audio cannot verify a broadcast', () => {
  const input = Array.from({ length: 160 }, (_, i) => makeFrame(i));
  const silent = input.slice(70, 130).map((frame) => ({
    ...frame,
    timeMs: frame.timeMs + 5000,
    leftRms: 0,
    rightRms: 0,
  }));
  assert.equal(findBroadcastMatch(input, silent), null);
});
