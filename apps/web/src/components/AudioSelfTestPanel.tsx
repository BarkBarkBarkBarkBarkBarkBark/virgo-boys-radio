'use client';

import { useState } from 'react';

type Pipeline = {
  name: string;
  passed: boolean;
  rmsChangeDb: number;
  pumpingDb: number;
  bassChangeDb: number;
  trebleChangeDb: number;
  stereoDifferenceDb: number;
  bassPhaseErrorDeg: number;
  peakDbfs: number;
  clippedPercent: number;
  findings: string[];
};
type Result = {
  at: string;
  durationMs: number;
  method: string;
  signal: string;
  baseline: { rmsDbfs: number; peakDbfs: number; variationDb: number };
  pcmMp3: Pipeline;
  opusMp3: Pipeline;
  samples: { pcmMp3: string; opusMp3: string };
  limitations: string;
};

function signedDb(value: number) {
  return (value > 0 ? '+' : '') + value.toFixed(2) + ' dB';
}
function PipelineReport({ data, audio }: { data: Pipeline; audio: string }) {
  return (
    <div className="border border-stone-300 p-4 space-y-3">
      <div className="flex flex-wrap gap-3 items-center justify-between">
        <h3 className="font-bold text-sm">{data.name}</h3>
        <span className={'text-xs font-bold uppercase ' + (data.passed ? 'text-green-700' : 'text-red-700')}>
          {data.passed ? 'Within thresholds' : 'Check measured changes'}
        </span>
      </div>
      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
        {[
          ['RMS change', signedDb(data.rmsChangeDb)],
          ['Added pumping', data.pumpingDb.toFixed(2) + ' dB'],
          ['56 Hz sub-bass change', signedDb(data.bassChangeDb)],
          ['7.2 kHz treble change', signedDb(data.trebleChangeDb)],
          ['Stereo gain mismatch', data.stereoDifferenceDb.toFixed(2) + ' dB'],
          ['56 Hz phase/polarity error', data.bassPhaseErrorDeg.toFixed(1) + '°'],
          ['Peak / clipped', data.peakDbfs.toFixed(2) + ' dBFS / ' + data.clippedPercent.toFixed(2) + '%'],
        ].map(([name, value]) => (
          <div key={name}><dt className="text-muted">{name}</dt><dd className="font-mono font-semibold mt-1">{value}</dd></div>
        ))}
      </dl>
      {data.findings.length > 0 && <ul className="list-disc list-inside text-xs text-red-700 space-y-1">
        {data.findings.map((finding) => <li key={finding}>{finding}</li>)}
      </ul>}
      <div>
        <p className="text-xs text-muted mb-2">Optional: play the generated test audio on this phone. Headphones are needed to judge 56 Hz bass.</p>
        <audio controls preload="none" className="w-full" src={'data:audio/mpeg;base64,' + audio} aria-label={data.name + ' diagnostic sample'} />
      </div>
    </div>
  );
}

export function AudioSelfTestPanel() {
  const [open, setOpen] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [copyStatus, setCopyStatus] = useState('');

  const run = async () => {
    if (running) return;
    setRunning(true);
    setError('');
    setCopyStatus('');
    setResult(null);
    try {
      const response = await fetch('/api/ops/audio-self-test', {
        method: 'POST', cache: 'no-store',
      });
      const body = await response.json() as Result & { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Could not execute audio test');
      setResult(body);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Audio test unavailable');
    } finally {
      setRunning(false);
    }
  };

  const copyMetrics = async () => {
    if (!result) return;
    const { samples: _samples, ...metrics } = result;
    try {
      await navigator.clipboard.writeText(JSON.stringify(metrics, null, 2));
      setCopyStatus('Measurements copied without audio payloads.');
    } catch { setCopyStatus('Copying was blocked by the browser.'); }
  };

  return (
    <section className="border border-stone-400 bg-white/90">
      <button
        type="button" onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="w-full flex flex-wrap items-center justify-between p-5 text-left hover:bg-stone-50"
      >
        <span>
          <strong className="block text-xl">Audio quality self-test</strong>
          <span className="block text-xs text-muted mt-1">Private · run synthetic PCM and Opus tests on Fly from your phone</span>
        </span>
        <span className="text-sm font-mono">{open ? '− Close' : '+ Open test'}</span>
      </button>

      {open && <div className="border-t border-stone-300 p-4 sm:p-6 space-y-4">
        <p className="text-sm">
          Automatically measures sub-bass retention, added volume pumping, treble loss, clipping and stereo imbalance
          in two isolated server codec paths. No DJ microphone or production stream is used.
        </p>
        <p className="text-xs font-semibold text-amber-800">
          Run only while off air. The server refuses the test when a broadcaster or Icecast source is active.
        </p>
        <button type="button" onClick={() => void run()} disabled={running}
          className="bg-ink px-5 py-3 text-white text-xs font-bold uppercase tracking-wider disabled:opacity-50">
          {running ? 'Analyzing audio on Fly…' : 'Run audio self-test'}
        </button>
        {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
        {result && <div className="space-y-4" role="status">
          <div className="text-xs text-muted">
            <p>{new Date(result.at).toLocaleString()} · completed in {(result.durationMs / 1000).toFixed(1)}s</p>
            <p>{result.signal}</p>
            <p>Reference input: {result.baseline.rmsDbfs.toFixed(1)} dBFS RMS · {result.baseline.peakDbfs.toFixed(1)} dBFS peak</p>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <PipelineReport data={result.pcmMp3} audio={result.samples.pcmMp3} />
            <PipelineReport data={result.opusMp3} audio={result.samples.opusMp3} />
          </div>
          <button type="button" onClick={() => void copyMetrics()}
            className="border border-ink px-4 py-2 text-xs uppercase font-bold">
            Copy measurements as JSON
          </button>
          {copyStatus && <p className="text-xs text-muted">{copyStatus}</p>}
          <div className="text-xs text-muted space-y-2 border-t border-stone-200 pt-3">
            <p><strong>Scope:</strong> {result.method}.</p>
            <p><strong>Limitation:</strong> {result.limitations}</p>
            <p><strong>Interpretation:</strong> If both server tests are clean but your real broadcast pumps, the next target is the computer's capture source and actual browser processing settings. A clean result does not prove that Icecast or the iPhone are fault-free.</p>
          </div>
        </div>}
      </div>}
    </section>
  );
}
