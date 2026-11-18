import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { AudioTestBusyError, compareAudio, measureStereoPCM, runAudioSelfTest } from './audioSelfTest.js';

const sampleRate = 48000;
function steadyPCM(amplitude = 0.18): Buffer {
  const frames = sampleRate * 4;
  const data = Buffer.alloc(frames * 4);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.round(amplitude * 32767 * Math.sin(2 * Math.PI * 440 * frame / sampleRate));
    data.writeInt16LE(value, frame * 4);
    data.writeInt16LE(value, frame * 4 + 2);
  }
  return data;
}

test('steady synthetic audio has minimal RMS pumping and does not clip', () => {
  const measurement = measureStereoPCM(steadyPCM());
  assert.ok(Math.abs(measurement.rmsDbfs + 17.9) < 0.25);
  assert.ok(measurement.levelVariationDb < 0.05);
  assert.equal(measurement.clippedPercent, 0);
  assert.ok(measurement.peakDbfs < -14);
});

test('automated comparison flags artificial pumping and gain changes', () => {
  const baseline = measureStereoPCM(steadyPCM());
  const changed = steadyPCM();
  // Simulate a compressor pumping down every other half-second.
  for (let frame = 0; frame < sampleRate * 4; frame += 1) {
    if (Math.floor(frame / (sampleRate / 2)) % 2 === 0) continue;
    for (let channel = 0; channel < 2; channel += 1) {
      const offset = frame * 4 + channel * 2;
      changed.writeInt16LE(Math.round(changed.readInt16LE(offset) / 2), offset);
    }
  }
  const report = compareAudio(baseline, measureStereoPCM(changed), 'synthetic damage');
  assert.equal(report.passed, false);
  assert.ok(report.pumpingDb > 4, 'Expected audible level fluctuation to be detected');
});

test('bad or short PCM output cannot be treated as a successful test', () => {
  assert.throws(() => measureStereoPCM(Buffer.alloc(40)), /Invalid or truncated/);
});

const available = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;
test('offline Fly codec paths preserve steady 56 Hz bass without adding pumping', {
  skip: !available && 'FFmpeg not installed on this runner',
}, async () => {
  const pending = runAudioSelfTest();
  await assert.rejects(runAudioSelfTest(), AudioTestBusyError);
  const result = await pending;
  assert.equal(result.pcmMp3.passed, true, JSON.stringify(result.pcmMp3));
  assert.equal(result.opusMp3.passed, true, JSON.stringify(result.opusMp3));
  assert.ok(result.samples.pcmMp3.length > 120_000);
  assert.ok(result.samples.opusMp3.length > 120_000);
  assert.ok(result.pcmMp3.pumpingDb <= 1.5);
  assert.ok(result.opusMp3.pumpingDb <= 1.5);
  assert.ok(Math.abs(result.opusMp3.bassChangeDb) < 2.5);
  assert.ok(result.durationMs < 42_000);
});
