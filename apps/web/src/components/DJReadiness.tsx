'use client';

import { useCallback, useEffect, useState } from 'react';
import { BROADCAST_HOST, BROADCAST_MOUNT, BROADCAST_PORT, USE_ICECAST } from '@/lib/streamConfig';
import { ConnectionCheck } from './ConnectionCheck';

type Result = { channels: string; sampleRate: string; left: number; right: number; note: string };

export function DJReadiness() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const found = await navigator.mediaDevices.enumerateDevices();
      setDevices(found.filter((device) => device.kind === 'audioinput'));
    } catch { /* Permission may not yet be granted. */ }
  }, []);

  useEffect(() => {
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);

  const testInput = async () => {
    setTesting(true);
    setError('');
    setResult(null);
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Secure HTTPS or localhost is required for audio capture.');
      stream = await navigator.mediaDevices.getUserMedia({
        video: false,
        audio: {
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
          channelCount: { ideal: 2 },
          sampleRate: { ideal: 48000 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      await refreshDevices();
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('No audio capture track was returned.');
      const settings = track.getSettings();
      context = new AudioContext();
      await context.resume();
      const source = context.createMediaStreamSource(stream);
      const splitter = context.createChannelSplitter(2);
      const leftAnalyser = context.createAnalyser();
      const rightAnalyser = context.createAnalyser();
      leftAnalyser.fftSize = 2048;
      rightAnalyser.fftSize = 2048;
      source.connect(splitter);
      splitter.connect(leftAnalyser, 0);
      splitter.connect(rightAnalyser, 1);
      const leftData = new Float32Array(leftAnalyser.fftSize);
      const rightData = new Float32Array(rightAnalyser.fftSize);
      let leftPeak = 0;
      let rightPeak = 0;
      for (let n = 0; n < 24; n += 1) {
        leftAnalyser.getFloatTimeDomainData(leftData);
        rightAnalyser.getFloatTimeDomainData(rightData);
        for (const sample of leftData) leftPeak = Math.max(leftPeak, Math.abs(sample));
        for (const sample of rightData) rightPeak = Math.max(rightPeak, Math.abs(sample));
        await new Promise<void>((resolve) => window.setTimeout(resolve, 125));
      }
      const channels = settings.channelCount;
      const clipped = Math.max(leftPeak, rightPeak) >= 0.99;
      const quiet = Math.max(leftPeak, rightPeak) < 0.008;
      setResult({
        channels: channels ? String(channels) : 'Not reported',
        sampleRate: settings.sampleRate ? settings.sampleRate + ' Hz' : 'Not reported',
        left: leftPeak,
        right: rightPeak,
        note: clipped ? 'Possible clipping: lower your interface input gain.'
          : quiet ? 'Very low input level. Play a track through your interface and try again.'
          : channels === 1 ? 'Audio detected, but browser reports mono. Select a stereo input.'
          : 'Audio detected. Confirm final left/right routing by listening on a second device.',
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Unable to access the audio input.');
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
      if (context) void context.close();
      setTesting(false);
    }
  };

  const settings = BROADCAST_HOST && BROADCAST_PORT
    ? ['Host: ' + BROADCAST_HOST, 'Port: ' + BROADCAST_PORT, 'Mount: ' + BROADCAST_MOUNT, 'Username: source', 'Password: obtain privately from station admin'].join('\n')
    : '';

  const copySettings = async () => {
    try {
      await navigator.clipboard.writeText(settings);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section className="space-y-6">
      <div className="space-y-3">
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-muted">Broadcast booth</p>
        <h1 className="text-4xl font-bold uppercase tracking-[0.12em]">Bring your sound. Go live.</h1>
        <p className="max-w-3xl text-sm leading-6 text-muted">
          Connect your XDJ or mixer to a stereo line input on a Scarlett or Steinberg interface.
          Test audio locally, then use a trusted desktop encoder such as BUTT to send the station one high-quality live stream.
        </p>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <div className="border border-ink/15 bg-white/80 p-6 space-y-4">
          <h2 className="text-xl font-bold">1. Test your audio interface</h2>
          <label className="block text-xs text-muted">Audio source
            <select value={deviceId} onChange={(event) => setDeviceId(event.target.value)}
              className="block w-full mt-2 border border-stone-300 bg-white p-3 text-sm text-ink">
              <option value="">System default</option>
              {devices.map((device) => <option value={device.deviceId} key={device.deviceId}>{device.label || 'Audio input (' + device.deviceId.slice(0, 8) + ')'}</option>)}
            </select>
          </label>
          <button type="button" onClick={() => void testInput()} disabled={testing}
            className="bg-ink text-paper px-6 py-3 text-sm font-bold uppercase tracking-[0.16em] disabled:opacity-50">
            {testing ? 'Testing audio for 3 seconds…' : 'Test audio interface'}
          </button>
          {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
          {result && <div aria-live="polite" className="border-t border-stone-200 pt-4 space-y-2 text-sm">
            <p><strong>Channels:</strong> {result.channels} · <strong>Sample rate:</strong> {result.sampleRate}</p>
            <p><strong>Left peak:</strong> {(result.left * 100).toFixed(1)}% · <strong>Right peak:</strong> {(result.right * 100).toFixed(1)}%</p>
            <p className="text-muted">{result.note}</p>
          </div>}
          <p className="text-xs text-muted">Local test only. It does not upload, record or publish audio. Browser channel reporting is not always reliable.</p>
        </div>
        <div className="border border-ink/15 bg-white/80 p-6 space-y-4">
          <h2 className="text-xl font-bold">2. Connect your encoder</h2>
          <p className="text-sm text-muted">Install <a className="underline" href="https://danielnoethen.de/butt/" target="_blank" rel="noreferrer">BUTT</a>, select the stereo interface, choose FLAC contribution if supported (or high-quality MP3), and configure:</p>
          {settings ? <>
            <pre className="bg-stone-100 p-3 overflow-x-auto whitespace-pre-wrap text-xs">{settings}</pre>
            <button type="button" onClick={() => void copySettings()} className="border border-ink px-4 py-2 text-xs font-bold uppercase tracking-widest">
              {copied ? 'Copied setup details' : 'Copy setup (no password)'}
            </button>
          </> : <p className="text-sm text-amber-800">Broadcast ingest is not configured in this deployment. See TODO.md for the required host, mount and credential setup.</p>}
          <p className="text-xs text-muted">Source passwords are private. Never paste them into a public website or expose them through NEXT_PUBLIC_* environment variables.</p>
        </div>
      </div>
      <div className="border border-ink/15 bg-white/80 p-6 space-y-3">
        <h2 className="text-xl font-bold">3. Verify the public broadcast</h2>
        {USE_ICECAST ? <ConnectionCheck /> : <p className="text-sm text-muted">The public Icecast listener endpoint is not configured yet; legacy WebRTC is available below for development only.</p>}
        <p className="text-xs text-muted">The listener test does not verify your ingest stream. Use a second device and confirm the actual mix is audible.</p>
      </div>
    </section>
  );
}
