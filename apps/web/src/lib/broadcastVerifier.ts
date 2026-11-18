/**
 * Passive end-to-end broadcast verification.
 *
 * Reads the DJ's existing L/R analyser nodes and a SECOND, silent public
 * Icecast listener. It never inserts test audio into the DJ signal path.
 * This is a content/continuity check, not a bit-perfect MP3 fidelity test.
 *
 * Icecast sets Access-Control-Allow-Origin: * in infra/fly/icecast.xml.template.
 * crossOrigin MUST be set before the HTMLAudioElement gets a source; otherwise
 * Web Audio must return silence for a cross-origin media element.
 */

export type VerificationPhase = 'idle' | 'checking' | 'verified' | 'warning' | 'unavailable';

export interface BroadcastVerification {
  phase: VerificationPhase;
  label: string;
  delayMs?: number;
  matchPercent?: number;
  detail?: string;
}

export interface BroadcastVerifier {
  /** A retry needs a user gesture if the browser blocked autoplay. */
  retry: () => void;
  stop: () => void;
}

type Sample = {
  timeMs: number;
  spectrum: number[];
  leftRms: number;
  rightRms: number;
  leftPeak: number;
  rightPeak: number;
};

type Match = {
  score: number;
  delayMs: number;
  input: Sample[];
  output: Sample[];
  bands: number;
};

const SAMPLE_PERIOD_MS = 100;
const WINDOW_SAMPLES = 40; // 4 seconds of time-varying musical content
const HISTORY_SAMPLES = 500; // 50 seconds, includes large Icecast buffers
const MIN_DELAY_MS = 350;
const MAX_DELAY_MS = 35_000;
const MATCH_THRESHOLD = 0.64;
const MIN_MATCH_BANDS = 4;
const SILENCE_RMS = 0.0025;
const BANDS: ReadonlyArray<readonly [number, number]> = [
  [70, 200], [200, 500], [500, 1200], [1200, 3000], [3000, 8000],
];

function avgLevel(samples: Sample[], channel: 'leftRms' | 'rightRms'): number {
  return samples.reduce((sum, frame) => sum + frame[channel], 0) / samples.length;
}

function averagePeak(samples: Sample[], channel: 'leftPeak' | 'rightPeak'): number {
  return samples.reduce((sum, frame) => sum + (frame[channel] > 0.995 ? 1 : 0), 0) / samples.length;
}

/**
 * Normalized band-envelope cross-correlation. Gain and MP3 encoding alter the
 * exact samples; the timing of changes in independent frequency bands survives.
 * Ignore nearly stationary bands so silence and steady tones cannot pass.
 */
export function compareFingerprints(
  input: Sample[],
  output: Sample[],
  reverseStereo = false,
): { score: number; bands: number } {
  const count = Math.min(input.length, output.length);
  if (count < WINDOW_SAMPLES) return { score: 0, bands: 0 };
  const bandCount = BANDS.length * 2;
  let weightedScore = 0;
  let totalWeight = 0;
  let usable = 0;

  for (let band = 0; band < bandCount; band += 1) {
    const receivedBand = reverseStereo ? (band + BANDS.length) % bandCount : band;
    let sourceMean = 0;
    let outputMean = 0;
    for (let i = 0; i < count; i += 1) {
      sourceMean += input[i]!.spectrum[band] ?? -100;
      outputMean += output[i]!.spectrum[receivedBand] ?? -100;
    }
    sourceMean /= count;
    outputMean /= count;

    let cov = 0;
    let sourceVariance = 0;
    let outputVariance = 0;
    for (let i = 0; i < count; i += 1) {
      const a = (input[i]!.spectrum[band] ?? -100) - sourceMean;
      const b = (output[i]!.spectrum[receivedBand] ?? -100) - outputMean;
      cov += a * b;
      sourceVariance += a * a;
      outputVariance += b * b;
    }

    const sourceStd = Math.sqrt(sourceVariance / count);
    const outputStd = Math.sqrt(outputVariance / count);
    // Static signals do not provide a reliable time signature.
    if (sourceStd < 2 || outputStd < 1.5) continue;
    const weight = Math.min(2, sourceStd / 5);
    const correlation = cov / Math.sqrt(sourceVariance * outputVariance);
    weightedScore += Math.max(-1, Math.min(1, correlation)) * weight;
    totalWeight += weight;
    usable += 1;
  }

  return { score: totalWeight ? weightedScore / totalWeight : 0, bands: usable };
}

/** Finds the matching DJ passage that arrived at the public listener later. */
export function findBroadcastMatch(input: Sample[], output: Sample[]): Match | null {
  if (output.length < WINDOW_SAMPLES || input.length < WINDOW_SAMPLES * 2) return null;
  const heard = output.slice(-WINDOW_SAMPLES);
  const heardAt = heard[heard.length - 1]!.timeMs;
  const heardLoudEnough = Math.max(avgLevel(heard, 'leftRms'), avgLevel(heard, 'rightRms')) > SILENCE_RMS;
  if (!heardLoudEnough) return null;

  let best: Match | null = null;
  for (let start = input.length - WINDOW_SAMPLES; start >= 0; start -= 1) {
    const lastInput = input[start + WINDOW_SAMPLES - 1]!;
    const delayMs = heardAt - lastInput.timeMs;
    if (delayMs < MIN_DELAY_MS) continue;
    if (delayMs > MAX_DELAY_MS) break;

    const candidate = input.slice(start, start + WINDOW_SAMPLES);
    if (Math.max(avgLevel(candidate, 'leftRms'), avgLevel(candidate, 'rightRms')) <= SILENCE_RMS) continue;
    const match = compareFingerprints(candidate, heard);
    if (match.bands < MIN_MATCH_BANDS) continue;

    if (!best || match.score > best.score) {
      best = { ...match, delayMs, input: candidate, output: heard };
    }
  }
  return best;
}

function makeSampler(context: AudioContext, left: AnalyserNode, right: AnalyserNode) {
  const fftSize = left.fftSize;
  const spectrumLength = left.frequencyBinCount;
  const leftSpectrum = new Float32Array(spectrumLength);
  const rightSpectrum = new Float32Array(spectrumLength);
  const leftWaveform = new Float32Array(fftSize);
  const rightWaveform = new Float32Array(fftSize);
  const hzPerBin = context.sampleRate / fftSize;

  const summarize = (\n    analyser: AnalyserNode,\n    spectrum: Parameters<AnalyserNode['getFloatFrequencyData']>[0],\n    waveform: Parameters<AnalyserNode['getFloatTimeDomainData']>[0],\n  ) => {
    analyser.getFloatFrequencyData(spectrum);
    analyser.getFloatTimeDomainData(waveform);
    let power = 0;
    let peak = 0;
    for (let index = 0; index < waveform.length; index += 1) {
      const sample = waveform[index] ?? 0;
      power += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }

    const features = BANDS.map(([low, high]) => {
      const first = Math.max(0, Math.floor(low / hzPerBin));
      const last = Math.min(spectrum.length, Math.ceil(high / hzPerBin));
      let bandPower = 0;
      for (let index = first; index < last; index += 1) {
        const db = Math.max(-110, Math.min(0, (spectrum[index] ?? -110)));
        bandPower += 10 ** (db / 10);
      }
      return 10 * Math.log10(bandPower / Math.max(1, last - first) + 1e-12);
    });
    return { features, rms: Math.sqrt(power / waveform.length), peak };
  };

  return (timeMs: number): Sample => {
    const l = summarize(left, leftSpectrum, leftWaveform);
    const r = summarize(right, rightSpectrum, rightWaveform);
    return {
      timeMs,
      spectrum: [...l.features, ...r.features],
      leftRms: l.rms,
      rightRms: r.rms,
      leftPeak: l.peak,
      rightPeak: r.peak,
    };
  };
}

export function startBroadcastVerifier(options: {
  context: AudioContext;
  sourceLeft: AnalyserNode;
  sourceRight: AnalyserNode;
  streamUrl: string;
  onUpdate: (result: BroadcastVerification) => void;
}): BroadcastVerifier {
  const { context, sourceLeft, sourceRight, streamUrl, onUpdate } = options;
  let stopped = false;
  let framesIn: Sample[] = [];
  let framesOut: Sample[] = [];
  let lastCheck = 0;
  let lastPass = 0;
  let goodMatches = 0;
  let previousDelay: number | null = null;
  let playbackStarted = false;

  if (!streamUrl || !/^https:\/\//i.test(streamUrl)) {
    onUpdate({ phase: 'unavailable', label: 'Verification unavailable', detail: 'Public HTTPS stream is not configured.' });
    return { retry: () => undefined, stop: () => undefined };
  }

  const audio = document.createElement('audio');
  audio.crossOrigin = 'anonymous';
  audio.preload = 'none';
  audio.volume = 1; // Zero-gain AudioContext output handles muting, not mediaElement.muted.

  const monitorSource = context.createMediaElementSource(audio);
  const splitter = context.createChannelSplitter(2);
  const left = context.createAnalyser();
  const right = context.createAnalyser();
  left.fftSize = sourceLeft.fftSize;
  right.fftSize = sourceRight.fftSize;
  left.smoothingTimeConstant = sourceLeft.smoothingTimeConstant;
  right.smoothingTimeConstant = sourceRight.smoothingTimeConstant;
  monitorSource.connect(splitter);
  splitter.connect(left, 0);
  splitter.connect(right, 1);

  // The listener decoder runs through a SILENT graph; it cannot feed back
  // into the DJ's mixer, microphone, or transmitted AudioWorklet.
  const silence = context.createGain();
  silence.gain.value = 0;
  left.connect(silence);
  right.connect(silence);
  silence.connect(context.destination);

  const readInput = makeSampler(context, sourceLeft, sourceRight);
  const readOutput = makeSampler(context, left, right);
  const checking: BroadcastVerification = {
    phase: 'checking',
    label: 'Verifying broadcast…',
    detail: 'Matching your audio against the public listener stream.',
  };
  onUpdate(checking);

  const onPlaying = () => { playbackStarted = true; };
  const onError = () => {
    if (!stopped) onUpdate({
      phase: 'unavailable',
      label: 'Listener check unavailable',
      detail: 'The public stream could not be decoded. Open Connection details to retry.',
    });
  };
  audio.addEventListener('playing', onPlaying);
  audio.addEventListener('error', onError);

  const tick = () => {
    if (stopped) return;
    const now = performance.now();
    if (context.state !== 'running') {
      onUpdate({ phase: 'checking', label: 'Verification paused', detail: 'Audio processing is suspended by the browser.' });
      return;
    }
    framesIn.push(readInput(now));
    if (framesIn.length > HISTORY_SAMPLES) framesIn.shift();
    if (playbackStarted && !audio.paused && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      framesOut.push(readOutput(now));
      if (framesOut.length > HISTORY_SAMPLES) framesOut.shift();
    } else {
      // Do not match the same stale decoder buffer after a stream interruption.
      framesOut = [];
    }

    if (now - lastCheck < 1500) return;
    lastCheck = now;
    if (framesOut.length < WINDOW_SAMPLES) {
      onUpdate(checking);
      return;
    }

    const match = findBroadcastMatch(framesIn, framesOut);
    if (match && match.score >= MATCH_THRESHOLD) {
      const closeToLast = previousDelay === null || Math.abs(previousDelay - match.delayMs) < 2500;
      goodMatches = closeToLast ? goodMatches + 1 : 1;
      previousDelay = match.delayMs;
      if (goodMatches >= 2) lastPass = now;

      const sourceLoudL = avgLevel(match.input, 'leftRms') > SILENCE_RMS * 2;
      const sourceLoudR = avgLevel(match.input, 'rightRms') > SILENCE_RMS * 2;
      const returnedL = avgLevel(match.output, 'leftRms') > SILENCE_RMS;
      const returnedR = avgLevel(match.output, 'rightRms') > SILENCE_RMS;
      const channelMissing = (sourceLoudL && !returnedL) || (sourceLoudR && !returnedR);
      const clippingRisk = averagePeak(match.output, 'leftPeak') > 0.12
        || averagePeak(match.output, 'rightPeak') > 0.12
        || averagePeak(match.input, 'leftPeak') > 0.12
        || averagePeak(match.input, 'rightPeak') > 0.12;

      const qualityWarning = channelMissing ? 'One stereo channel is missing.'
        : clippingRisk ? 'Signal is close to clipping.'
        : null;
      const result: BroadcastVerification = {
        phase: qualityWarning ? 'warning' : goodMatches >= 2 ? 'verified' : 'checking',
        label: qualityWarning ? 'Check audio levels' : goodMatches >= 2 ? 'Broadcast verified' : 'Matching audio…',
        delayMs: Math.round(match.delayMs / 100) * 100,
        matchPercent: Math.round(Math.max(0, match.score) * 100),
        detail: qualityWarning ?? 'Decoded public audio matches the DJ input. No test signal was added.',
      };
      onUpdate(result);
      return;
    }

    goodMatches = 0;
    previousDelay = null;
    if (lastPass && now - lastPass < 12_000) return;
    const heardEnergy = avgLevel(framesOut.slice(-WINDOW_SAMPLES), 'leftRms')
      + avgLevel(framesOut.slice(-WINDOW_SAMPLES), 'rightRms');
    onUpdate({
      phase: now - (framesIn[0]?.timeMs ?? now) < 12_000 ? 'checking' : 'warning',
      label: heardEnergy < SILENCE_RMS ? 'Waiting for listener audio' : 'Broadcast not confirmed',
      detail: heardEnergy < SILENCE_RMS
        ? 'No decoded audio is reaching the silent listener yet.'
        : 'The returned stream has not matched the outgoing music. Check the station on another device.',
    });
  };

  const interval = window.setInterval(tick, SAMPLE_PERIOD_MS);
  const retry = () => {
    if (stopped) return;
    framesIn = [];
    framesOut = [];
    goodMatches = 0;
    lastPass = 0;
    previousDelay = null;
    playbackStarted = false;
    onUpdate(checking);
    audio.pause();
    audio.src = streamUrl;
    audio.load();
    void audio.play().catch(() => {
      if (!stopped) onUpdate({
        phase: 'unavailable',
        label: 'Tap to enable verification',
        detail: 'The browser blocked silent playback. Use the Retry check button.',
      });
    });
  };

  retry();

  return {
    retry,
    stop: () => {
      if (stopped) return;
      stopped = true;
      window.clearInterval(interval);
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('error', onError);
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      monitorSource.disconnect();
      splitter.disconnect();
      left.disconnect();
      right.disconnect();
      silence.disconnect();
      framesIn = [];
      framesOut = [];
    },
  };
}
