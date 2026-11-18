import { spawn } from 'node:child_process';
import { ffmpegInputArgs } from './djFormat.js';

/**
 * Server-only, synthetic, offline audio QA. Never touches the live Icecast
 * mount, user microphones, WebSocket sessions, or production audio.
 *
 * Compare: generated PCM -> MP3 -> PCM vs
 *          generated PCM -> WebM/Opus -> MP3 -> PCM.
 * This can exonerate/implicate the SERVER codec chain, but cannot diagnose
 * hardware/OS gain processing or measure a real phone's speakers.
 */
const SAMPLE_RATE = 48_000;
const SECONDS = 4;
const WINDOW_FRAMES = SAMPLE_RATE / 4;
const START_FRAME = SAMPLE_RATE / 2;
const MAX_OUTPUT = 3 * 1024 * 1024;
const TONE_CHANNELS = [[56, 440, 7200], [56, 880, 7200]] as const;

export type AudioMeasurements = {
  durationSeconds: number;
  rmsDbfs: number;
  peakDbfs: number;
  clippedPercent: number;
  levelVariationDb: number;
  tonesDbfs: number[][];
};
export type AudioPipelineResult = {
  name: string;
  passed: boolean;
  rmsChangeDb: number;
  pumpingDb: number;
  bassChangeDb: number;
  trebleChangeDb: number;
  stereoDifferenceDb: number;
  peakDbfs: number;
  clippedPercent: number;
  findings: string[];
};
export type AudioSelfTestResult = {
  at: string;
  durationMs: number;
  method: string;
  signal: string;
  baseline: { rmsDbfs: number; peakDbfs: number; variationDb: number };
  pcmMp3: AudioPipelineResult;
  opusMp3: AudioPipelineResult;
  samples: { pcmMp3: string; opusMp3: string };
  limitations: string;
};

export class AudioTestBusyError extends Error {}
let running = false;

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
function db(value: number): number {
  return 20 * Math.log10(Math.max(value, 1e-9));
}
function generateStereoPCM(): Buffer {
  const buffer = Buffer.alloc(SAMPLE_RATE * SECONDS * 4);
  for (let index = 0; index < SAMPLE_RATE * SECONDS; index += 1) {
    const t = index / SAMPLE_RATE;
    const left = 0.12 * Math.sin(2 * Math.PI * 56 * t)
      + 0.10 * Math.sin(2 * Math.PI * 440 * t)
      + 0.06 * Math.sin(2 * Math.PI * 7200 * t);
    const right = 0.115 * Math.sin(2 * Math.PI * 56 * t + 0.02)
      + 0.11 * Math.sin(2 * Math.PI * 880 * t)
      + 0.055 * Math.sin(2 * Math.PI * 7200 * t + 0.17);
    buffer.writeInt16LE(Math.round(left * 32767), index * 4);
    buffer.writeInt16LE(Math.round(right * 32767), index * 4 + 2);
  }
  return buffer;
}

/** Compute coherent DFT tone amplitudes for each channel over middle windows. */
function toneAmplitude(data: Buffer, startFrame: number, channel: number, frequency: number): number {
  const w = 2 * Math.PI * frequency / SAMPLE_RATE;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  let c = 1;
  let s = 0;
  let re = 0;
  let im = 0;
  for (let i = 0; i < WINDOW_FRAMES; i += 1) {
    const v = data.readInt16LE((startFrame + i) * 4 + channel * 2) / 32768;
    re += v * c;
    im += v * s;
    const nextC = c * cw - s * sw;
    s = s * cw + c * sw;
    c = nextC;
  }
  return 2 * Math.hypot(re, im) / WINDOW_FRAMES;
}
export function measureStereoPCM(data: Buffer): AudioMeasurements {
  if (data.length % 4 !== 0 || data.length < 2 * SAMPLE_RATE * 4) {
    throw new Error('Invalid or truncated stereo PCM diagnostic output');
  }
  const totalFrames = data.length / 4;
  const endFrame = Math.min(totalFrames - START_FRAME, (SECONDS - 0.5) * SAMPLE_RATE);
  const rmsWindows: number[] = [];
  const tones: number[][] = [[], []];
  const toneSums = [[0, 0, 0], [0, 0, 0]];
  let peak = 0;
  let clipped = 0;
  let readSamples = 0;
  let totalPower = 0;
  for (let frame = START_FRAME; frame + WINDOW_FRAMES <= endFrame; frame += WINDOW_FRAMES) {
    let power = 0;
    for (let i = 0; i < WINDOW_FRAMES; i += 1) {
      for (let channel = 0; channel < 2; channel += 1) {
        const value = data.readInt16LE((frame + i) * 4 + channel * 2) / 32768;
        power += value * value;
        peak = Math.max(peak, Math.abs(value));
        if (Math.abs(value) >= 0.995) clipped += 1;
        readSamples += 1;
      }
    }
    totalPower += power;
    rmsWindows.push(db(Math.sqrt(power / (WINDOW_FRAMES * 2))));
    for (let channel = 0; channel < 2; channel += 1) {
      for (let t = 0; t < 3; t += 1) {
        toneSums[channel]![t]! += toneAmplitude(data, frame, channel, TONE_CHANNELS[channel]![t]!);
      }
    }
  }
  if (rmsWindows.length < 7) throw new Error('Diagnostic output has insufficient stable audio windows');
  for (let channel = 0; channel < 2; channel += 1) {
    for (let t = 0; t < 3; t += 1) tones[channel]!.push(db(toneSums[channel]![t]! / rmsWindows.length));
  }
  return {
    durationSeconds: round(totalFrames / SAMPLE_RATE),
    rmsDbfs: round(db(Math.sqrt(totalPower / readSamples))),
    peakDbfs: round(db(peak)),
    clippedPercent: round(clipped / readSamples * 100),
    levelVariationDb: round(Math.max(...rmsWindows) - Math.min(...rmsWindows)),
    tonesDbfs: tones,
  };
}

export function compareAudio(reference: AudioMeasurements, measured: AudioMeasurements, name: string): AudioPipelineResult {
  const avgTone = (tone: number) =>
    ((measured.tonesDbfs[0]![tone]! - reference.tonesDbfs[0]![tone]!)
      + (measured.tonesDbfs[1]![tone]! - reference.tonesDbfs[1]![tone]!)) / 2;
  const bass = avgTone(0);
  const treble = avgTone(2);
  const rMs = measured.rmsDbfs - reference.rmsDbfs;
  const pumping = Math.max(0, measured.levelVariationDb - reference.levelVariationDb);
  // Channel-differential gain reveals stereo imbalance; mono testing alone
  // cannot rule out polarity inversion or playback-device bass rolloff.
  const leftMidChange = measured.tonesDbfs[0]![1]! - reference.tonesDbfs[0]![1]!;
  const rightMidChange = measured.tonesDbfs[1]![1]! - reference.tonesDbfs[1]![1]!;
  const imbalance = Math.abs(leftMidChange - rightMidChange);
  const findings: string[] = [];
  if (Math.abs(rMs) > 2) findings.push('Overall RMS changed by more than 2 dB');
  if (pumping > 1.5) findings.push('Added more than 1.5 dB of fluctuation to a steady signal');
  if (Math.abs(bass) > 2.5) findings.push('56 Hz sub-bass amplitude changed by more than 2.5 dB');
  if (Math.abs(treble) > 3.5) findings.push('7.2 kHz treble amplitude changed by more than 3.5 dB');
  if (imbalance > 2) findings.push('Left/right channel gain is inconsistent');
  if (measured.clippedPercent > 0.01) findings.push('Output includes samples at digital full scale');
  return {
    name, passed: findings.length === 0,
    rmsChangeDb: round(rMs), pumpingDb: round(pumping),
    bassChangeDb: round(bass), trebleChangeDb: round(treble),
    stereoDifferenceDb: round(imbalance),
    peakDbfs: measured.peakDbfs, clippedPercent: measured.clippedPercent,
    findings,
  };
}

async function ffmpeg(input: Buffer, args: string[], stage: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/ffmpeg',
      ['-hide_banner', '-nostdin', '-loglevel', 'error', '-threads', '1', ...args],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    const fragments: Buffer[] = [];
    let total = 0;
    let failed = '';
    const timeout = setTimeout(() => {
      failed = 'Time limit exceeded';
      child.kill('SIGKILL');
    }, 9000);
    child.stdout.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_OUTPUT) {
        failed = 'Output size exceeded';
        child.kill('SIGKILL');
      } else {
        fragments.push(chunk);
      }
    });
    // Never relay arbitrary process stderr; stage names are fixed and safe.
    child.stderr.resume();
    child.stdin.on('error', () => undefined); // EPIPE is reflected in close code.
    child.on('error', () => {
      failed = 'FFmpeg could not start';
      clearTimeout(timeout);
      reject(new Error(stage + ': ' + failed));
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      if (failed || code !== 0 || !total) reject(new Error(stage + ': ' + (failed || 'FFmpeg exited unexpectedly')));
      else resolve(Buffer.concat(fragments));
    });
    child.stdin.end(input);
  });
}

const MP3_OUT = ['-c:a', 'libmp3lame', '-b:a', '320k', '-ar', '48000', '-ac', '2', '-f', 'mp3', 'pipe:1'];
const PCM_OUT = ['-ar', '48000', '-ac', '2', '-f', 's16le', 'pipe:1'];

export async function runAudioSelfTest(): Promise<AudioSelfTestResult> {
  if (running) throw new AudioTestBusyError('An audio diagnostic is already running.');
  running = true;
  const started = Date.now();
  try {
    const original = generateStereoPCM();
    const baseline = measureStereoPCM(original);
    const pcmMp3Bytes = await ffmpeg(original, [...ffmpegInputArgs('pcm_s16le'), ...MP3_OUT], 'PCM to MP3');
    const pcmDecoded = await ffmpeg(pcmMp3Bytes, ['-f', 'mp3', '-i', 'pipe:0', ...PCM_OUT], 'Decode MP3');
    const opusWebm = await ffmpeg(original, [...ffmpegInputArgs('pcm_s16le'),
      '-c:a', 'libopus', '-b:a', '192k', '-application', 'audio', '-f', 'webm', 'pipe:1'], 'Encode Opus');
    const opusMp3Bytes = await ffmpeg(opusWebm, [...ffmpegInputArgs('webm_opus'), ...MP3_OUT], 'Opus to MP3');
    const opusDecoded = await ffmpeg(opusMp3Bytes, ['-f', 'mp3', '-i', 'pipe:0', ...PCM_OUT], 'Decode Opus/MP3');
    return {
      at: new Date().toISOString(), durationMs: Date.now() - started,
      method: 'Offline synthetic audio processed on Fly with the station FFmpeg codec settings',
      signal: '4 seconds of steady stereo 56 Hz sub-bass, 440/880 Hz midrange, and 7.2 kHz treble; -18 dBFS approximately',
      baseline: { rmsDbfs: baseline.rmsDbfs, peakDbfs: baseline.peakDbfs, variationDb: baseline.levelVariationDb },
      pcmMp3: compareAudio(baseline, measureStereoPCM(pcmDecoded), 'PCM → MP3'),
      opusMp3: compareAudio(baseline, measureStereoPCM(opusDecoded), 'Opus → MP3'),
      samples: { pcmMp3: pcmMp3Bytes.toString('base64'), opusMp3: opusMp3Bytes.toString('base64') },
      limitations: 'Does not touch or verify the real DJ input, computer audio settings, WebSocket link, Icecast mount, network, iPhone decoder, or speaker response. Opus here is encoded by FFmpeg, not the browser MediaRecorder.',
    };
  } finally { running = false; }
}
