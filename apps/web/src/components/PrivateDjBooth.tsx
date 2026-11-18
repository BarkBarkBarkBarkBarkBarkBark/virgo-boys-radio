'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '@/lib/api';
import { PUBLIC_STREAM_URL } from '@/lib/streamConfig';
import { startBroadcastVerifier, type BroadcastVerification, type BroadcastVerifier } from '@/lib/broadcastVerifier';

type AudioSource = 'tone' | 'tab' | 'interface';
type BoothState = 'idle' | 'testing' | 'connecting' | 'sending' | 'error';
type Meter = { left: number; right: number };

const SOURCES: { id: AudioSource; name: string; description: string }[] = [
  { id: 'interface', name: 'Audio interface', description: 'Your mixer or USB audio input' },
  { id: 'tab', name: 'Browser tab', description: 'Audio from another tab' },
  { id: 'tone', name: 'Test tone', description: 'Check your stereo connection' },
];

export function PrivateDjBooth() {
  const [hasInvite, setHasInvite] = useState(false);
  const [entryCode, setEntryCode] = useState('');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [pendingBytes, setPendingBytes] = useState<number | null>(null);
  const [lastClose, setLastClose] = useState('');
  const [source, setSource] = useState<AudioSource>('interface');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [state, setState] = useState<BoothState>('idle');
  const [message, setMessage] = useState('Select an audio source, then test it locally.');
  const [meter, setMeter] = useState<Meter>({ left: 0, right: 0 });
  const [sourceNote, setSourceNote] = useState('');
  const [sent, setSent] = useState(0);
  const [publicStatus, setPublicStatus] = useState<'idle' | 'checking' | 'available' | 'unavailable'>('idle');
  const [verification, setVerification] = useState<BroadcastVerification>({ phase: 'idle', label: 'Off air' });
  const inviteRef = useRef('');
  const wsRef = useRef<WebSocket | null>(null);
  const stateRef = useRef<BoothState>('idle');
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const oscillatorsRef = useRef<OscillatorNode[]>([]);
  const meterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const testTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const verifierRef = useRef<BroadcastVerifier | null>(null);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const found = await navigator.mediaDevices.enumerateDevices();
      setDevices(found.filter((d) => d.kind === 'audioinput'));
    } catch { /* Device labels become available after microphone permission. */ }
  }, []);

  useEffect(() => {
    const token = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
    if (/^[0-9a-f]{64}$/i.test(token)) {
      inviteRef.current = token;
      setHasInvite(true);
    }
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);

  const cleanup = useCallback(() => {
    verifierRef.current?.stop();
    verifierRef.current = null;
    const socket = wsRef.current;
    wsRef.current = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) socket.close(1000, 'operator_or_page_stop');
    if (meterTimerRef.current) clearInterval(meterTimerRef.current);
    if (testTimerRef.current) clearTimeout(testTimerRef.current);
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    retryTimerRef.current = null;
    heartbeatRef.current = null;
    meterTimerRef.current = null;
    testTimerRef.current = null;
    checkTimerRef.current = null;
    for (const oscillator of oscillatorsRef.current) {
      try { oscillator.stop(); } catch { /* Already stopped. */ }
    }
    oscillatorsRef.current = [];
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (contextRef.current) void contextRef.current.close();
    contextRef.current = null;
    setMeter({ left: 0, right: 0 });
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const stop = () => {
    cleanup();
    stateRef.current = 'idle';
    setState('idle');
    setPublicStatus('idle');
    setVerification({ phase: 'idle', label: 'Off air' });
    setMessage('Off air. Audio capture has stopped.');
  };

  const checkPublicStream = useCallback(async () => {
    if (!PUBLIC_STREAM_URL) {
      setPublicStatus('unavailable');
      return;
    }
    setPublicStatus('checking');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      // Fetch only the response headers. Never download or buffer the infinite stream.
      const response = await fetch(PUBLIC_STREAM_URL, { signal: controller.signal, cache: 'no-store' });
      setPublicStatus(response.ok ? 'available' : 'unavailable');
    } catch {
      setPublicStatus('unavailable');
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }, []);

  const run = async (testOnly: boolean) => {
    if (state === 'testing' || state === 'connecting' || state === 'sending') return;
    if (!testOnly && !hasInvite && !/^[A-HJ-NP-Z2-9]{12}$/.test(entryCode)) {
      setMessage('A private broadcast invitation is required to go live. You can still test all three sources locally.');
      setState('error');
      return;
    }
    cleanup();
    setSent(0);
    setPublicStatus('idle');
    setVerification({ phase: 'idle', label: 'Off air' });
    setSourceNote('');
    setLatencyMs(null);
    setPendingBytes(null);
    setLastClose('');
    stateRef.current = 'connecting';
    setState('connecting');
    setMessage('Opening audio source…');

    try {
      if (!window.AudioWorkletNode || !window.AudioContext) {
        throw new Error('Use a recent desktop browser with HTTPS and Web Audio support.');
      }

      let stream: MediaStream | null = null;
      if (source === 'interface') {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('Audio inputs require browser permission.');
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
        const channels = stream.getAudioTracks()[0]?.getSettings().channelCount;
        setSourceNote(channels === 2 ? '2 input channels detected.'
          : channels === 1 ? 'Browser reports MONO. Choose a stereo source before an important set.'
          : 'Audio input active. Verify that both channels have signal.');
        void refreshDevices();
      } else if (source === 'tab') {
        if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('This browser cannot share tab audio. Use Chrome or Edge, or select a loopback input.');
        // Screen/video capture permission is required by browser APIs, but
        // the site sends ONLY the returned audio track to our encoder.
        const captured = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
        if (!captured.getAudioTracks().length) {
          captured.getTracks().forEach((track) => track.stop());
          throw new Error('No shared audio. In Chrome/Edge choose a browser tab, enable "Share tab audio", then try again.');
        }
        stream = captured;
        setSourceNote('Shared tab audio detected; video is not uploaded.');
        captured.getVideoTracks()[0]?.addEventListener('ended', () => {
          cleanup();
          setState('idle');
          setMessage('Tab sharing stopped. Audio is off air.');
        });
      } else {
        setSourceNote('Synthetic stereo signal: 440 Hz left / 660 Hz right. Headphones recommended for listening tests.');
      }

      streamRef.current = stream;
      const context = new AudioContext({ sampleRate: 48000 });
      contextRef.current = context;
      await context.audioWorklet.addModule('/dj-pcm-processor.js');
      await context.resume();

      let input: AudioNode;
      if (source === 'tone') {
        const left = context.createOscillator();
        const right = context.createOscillator();
        left.type = 'sine';
        right.type = 'sine';
        left.frequency.value = 440;
        right.frequency.value = 660;
        const leftGain = context.createGain();
        const rightGain = context.createGain();
        leftGain.gain.value = 0.12;
        rightGain.gain.value = 0.12;
        const merge = context.createChannelMerger(2);
        left.connect(leftGain).connect(merge, 0, 0);
        right.connect(rightGain).connect(merge, 0, 1);
        left.start();
        right.start();
        oscillatorsRef.current = [left, right];
        input = merge;
      } else {
        if (!stream) throw new Error('No audio source was opened.');
        input = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      }

      const splitter = context.createChannelSplitter(2);
      const leftMeter = context.createAnalyser();
      const rightMeter = context.createAnalyser();
      leftMeter.fftSize = 2048;
      rightMeter.fftSize = 2048;
      // Identical FFT smoothing for the source and public listener fingerprints.
      leftMeter.smoothingTimeConstant = 0.1;
      rightMeter.smoothingTimeConstant = 0.1;
      input.connect(splitter);
      splitter.connect(leftMeter, 0);
      splitter.connect(rightMeter, 1);

      // Keep analysers in an active graph without playing local audio or causing feedback.
      const silentOutput = context.createGain();
      silentOutput.gain.value = 0;
      leftMeter.connect(silentOutput);
      rightMeter.connect(silentOutput);
      silentOutput.connect(context.destination);

      const leftBuffer = new Float32Array(2048);
      const rightBuffer = new Float32Array(2048);
      meterTimerRef.current = setInterval(() => {
        leftMeter.getFloatTimeDomainData(leftBuffer);
        rightMeter.getFloatTimeDomainData(rightBuffer);
        let lp = 0;
        let rp = 0;
        for (let i = 0; i < leftBuffer.length; i += 1) {
          lp = Math.max(lp, Math.abs(leftBuffer[i] ?? 0));
          rp = Math.max(rp, Math.abs(rightBuffer[i] ?? 0));
        }
        setMeter({ left: lp, right: rp });
      }, 150);

      if (testOnly) {
        setState('testing');
        setMessage('Local five-second stereo test running. Audio is NOT being broadcast.');
        testTimerRef.current = setTimeout(() => {
          cleanup();
          stateRef.current = 'idle';
          setState('idle');
          setMessage('Local source test finished. Go Live to test the full Icecast path.');
        }, 5000);
        return;
      }

      const worklet = new AudioWorkletNode(context, 'virgo-pcm', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const workletSilence = context.createGain();
      workletSilence.gain.value = 0;
      worklet.connect(workletSilence).connect(context.destination);

      // The Web Audio graph stays connected while a WebSocket reconnects.
      // Do not silently turn off the DJ's source after a brief network interruption.
      const websocketUrl = API_BASE.replace(/^http/i, 'ws').replace(/\/$/, '') + '/dj/pcm';
      const SOFT_BUFFER_BYTES = 384 * 1024; // ~2 seconds of stereo PCM
      const RESUME_BUFFER_BYTES = 128 * 1024;
      const MAX_CONGESTION_MS = 12_000;
      const MAX_RECONNECTS = 5;
      let retries = 0;
      let attached = false;
      let congestionStarted = 0;
      let droppedFrames = 0;
      let lastDiagnostic = 0;
      let lastWarn = 0;
      let serverSupportsDiagnostics = false;

      // Deliver a current diagnostic over the socket when possible. Messages
      // are deliberately small, sent at most every five seconds.
      const reportAudioHealth = (socket: WebSocket, bufferedBytes: number) => {
        // Older Fly images reject unknown text frames as invalid audio.
        // Never send telemetry until the server explicitly advertises support.
        if (!serverSupportsDiagnostics || socket.readyState !== WebSocket.OPEN) return;
        const now = Date.now();
        if (now - lastDiagnostic < 5000) return;
        lastDiagnostic = now;
        socket.send(JSON.stringify({ type: 'client_diagnostics', droppedFrames, bufferedBytes }));
      };

      worklet.port.onmessage = (frame) => {
        const active = wsRef.current;
        if (!active || active.readyState !== WebSocket.OPEN || stateRef.current !== 'sending') return;
        const buffered = active.bufferedAmount;
        if (buffered >= SOFT_BUFFER_BYTES) {
          // Live audio must not accumulate multiple seconds of stale audio.
          // Drop delayed frames temporarily instead of instantly ending the set.
          droppedFrames += 1;
          if (!congestionStarted) congestionStarted = Date.now();
          if (Date.now() - lastWarn > 5000) {
            setMessage('Connection is slow — recovering audio in real time.');
            lastWarn = Date.now();
          }
          reportAudioHealth(active, buffered);
          if (Date.now() - congestionStarted > MAX_CONGESTION_MS) {
            active.close(4008, 'uplink_queue_stalled');
          }
          return;
        }
        if (buffered < RESUME_BUFFER_BYTES) congestionStarted = 0;
        active.send(frame.data as ArrayBuffer);
        reportAudioHealth(active, buffered);
      };

      const openSocket = () => {
        if (!contextRef.current) return;
        const socket = new WebSocket(websocketUrl);
        wsRef.current = socket;
        socket.binaryType = 'arraybuffer';
        socket.onopen = () => {
          socket.send(JSON.stringify({ type: 'auth', ...(hasInvite ? { token: inviteRef.current } : { code: entryCode }) }));
          setMessage(retries ? 'Reconnecting to the station…' : 'Connecting to the station…');
        };
        socket.onmessage = (event) => {
          if (wsRef.current !== socket) return;
          let reply: { type: string; message?: string; bytesReceived?: number; pendingBytes?: number; clientTime?: number; serverTime?: number; supportsClientDiagnostics?: number };
          try { reply = JSON.parse(event.data as string) as typeof reply; } catch { return; }
          if (reply.type === 'ready') {
            serverSupportsDiagnostics = reply.supportsClientDiagnostics === 1;
            if (!attached) {
              input.connect(worklet);
              attached = true;
            }
            if (heartbeatRef.current) clearInterval(heartbeatRef.current);
            heartbeatRef.current = setInterval(() => {
              if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'heartbeat', clientTime: Date.now() }));
            }, 5000);
            congestionStarted = 0;
            retries = 0;
            setState('sending');
            stateRef.current = 'sending';
            setMessage('Live · Connection healthy');
            verifierRef.current?.stop();
            verifierRef.current = null;
            setVerification({ phase: 'checking', label: 'Verifying broadcast…' });
            if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
            // Give FFmpeg/Icecast time to mount the new live stream before
            // opening a second, completely silent browser listener.
            checkTimerRef.current = setTimeout(() => {
              if (stateRef.current !== 'sending') return;
              verifierRef.current = startBroadcastVerifier({
                context,
                sourceLeft: leftMeter,
                sourceRight: rightMeter,
                streamUrl: PUBLIC_STREAM_URL,
                onUpdate: (result) => {
                  if (stateRef.current === 'sending') setVerification(result);
                },
              });
              void checkPublicStream();
            }, 2600);
          } else if (reply.type === 'stats') {
            setSent(reply.bytesReceived ?? 0);
            setPendingBytes(reply.pendingBytes ?? null);
          } else if (reply.type === 'heartbeat' && reply.clientTime) {
            setLatencyMs(Math.max(0, Date.now() - reply.clientTime));
          } else if (reply.type === 'error') {
            setLastClose(reply.message ?? 'Station rejected the uplink');
            setMessage(reply.message ?? 'Station rejected the uplink');
            setState('error');
            stateRef.current = 'error';
            cleanup();
          }
        };
        socket.onerror = () => {
          if (wsRef.current === socket) setMessage('Uplink interrupted. Checking connection…');
          // A close event follows; preserving the audio graph lets us retry.
        };
        socket.onclose = (event) => {
          if (wsRef.current !== socket) return;
          wsRef.current = null;
          if (heartbeatRef.current) clearInterval(heartbeatRef.current);
          heartbeatRef.current = null;
          congestionStarted = 0;
          serverSupportsDiagnostics = false;
          const reason = 'WebSocket ' + event.code + (event.reason ? ' · ' + event.reason : '');
          verifierRef.current?.stop();
          verifierRef.current = null;
          setVerification({ phase: 'checking', label: 'Reconnecting…' });
          if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
          checkTimerRef.current = null;
          setLastClose(reason);
          const retryable = [1001, 1005, 1006, 1011, 1012, 4008].includes(event.code);
          if (retryable && retries < MAX_RECONNECTS && contextRef.current) {
            const delay = Math.min(1000 * 2 ** retries, 12_000);
            retries += 1;
            setState('connecting');
            stateRef.current = 'connecting';
            setMessage('Connection lost. Reconnecting (' + retries + '/' + MAX_RECONNECTS + ')…');
            retryTimerRef.current = setTimeout(() => {
              retryTimerRef.current = null;
              openSocket();
            }, delay);
          } else {
            setMessage(reason + '. Broadcast stopped; check admin diagnostics.');
            setState('error');
            stateRef.current = 'error';
            cleanup();
          }
        };
      };
      openSocket();
    } catch (error) {
      cleanup();
      stateRef.current = 'error';
      setState('error');
      setMessage(error instanceof Error ? error.message : 'Audio source could not be opened.');
    }
  };

  const busy = state === 'testing' || state === 'connecting' || state === 'sending';
  const canBroadcast = hasInvite || /^[A-HJ-NP-Z2-9]{12}$/.test(entryCode);
  const meterPercent = (value: number) => Math.min(100, Math.round(Math.max(0, value) * 100));

  return (
    <section className="mx-auto max-w-3xl space-y-5">
      <header className="space-y-2">
        <p className="text-[10px] font-mono uppercase tracking-[0.3em] text-muted">Virgo Boys Radio / Private</p>
        <h1 className="text-3xl font-bold uppercase tracking-[0.12em] sm:text-4xl">DJ booth</h1>
        <p className="text-sm text-muted">Choose your input. Check your levels. Go live.</p>
      </header>

      <div className="space-y-7 border border-ink/15 bg-white/85 p-4 sm:p-6">
        <section aria-labelledby="input-heading" className="space-y-3">
          <h2 id="input-heading" className="text-sm font-bold uppercase tracking-[0.16em]">Audio input</h2>
          <div className="grid gap-2 sm:grid-cols-3">
            {SOURCES.map((item) => (
              <button
                type="button"
                key={item.id}
                disabled={busy}
                aria-pressed={source === item.id}
                onClick={() => { setSource(item.id); setState('idle'); setMessage('Source selected. Run a local test or go live.'); setMeter({ left: 0, right: 0 }); }}
                className={'min-h-[72px] border p-3 text-left transition-colors disabled:opacity-60 ' +
                  (source === item.id ? 'border-ink bg-paper' : 'border-ink/20 hover:border-ink')}
              >
                <span className="block text-sm font-bold">{item.name}</span>
                <span className="mt-1 block text-xs leading-4 text-muted">{item.description}</span>
              </button>
            ))}
          </div>

          {source === 'interface' && (
            <label className="block text-xs font-medium text-muted">
              Input device
              <select
                value={deviceId}
                disabled={busy}
                onChange={(event) => setDeviceId(event.target.value)}
                className="mt-2 w-full border border-stone-300 bg-white p-3 text-sm text-ink"
              >
                <option value="">System default</option>
                {devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || 'Audio input ' + device.deviceId.slice(0, 6)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {(source === 'interface' || source === 'tab') && (
            <details className="text-xs leading-5 text-muted">
              <summary className="w-fit cursor-pointer underline underline-offset-4">Input help</summary>
              <p className="mt-2">
                {source === 'interface'
                  ? 'Choose your stereo mixer or audio interface. For desktop playback, select a system loopback input.'
                  : 'In Chrome or Edge, share the tab playing audio and turn on Share tab audio.'}
              </p>
            </details>
          )}
        </section>

        <section aria-labelledby="levels-heading" className="space-y-3">
          <h2 id="levels-heading" className="text-sm font-bold uppercase tracking-[0.16em]">Levels</h2>
          <div className="space-y-2">
            {(['left', 'right'] as const).map((side) => (
              <div key={side} className="flex items-center gap-3 text-xs">
                <span className="w-5 font-mono font-bold uppercase">{side === 'left' ? 'L' : 'R'}</span>
                <div className="h-2 flex-1 bg-stone-200">
                  <div
                    className={'h-full transition-all ' + (meter[side] >= 0.99 ? 'bg-red-600' : 'bg-ink')}
                    style={{ width: meterPercent(meter[side]) + '%' }}
                  />
                </div>
                <span className="w-10 text-right font-mono">{meterPercent(meter[side])}%</span>
              </div>
            ))}
          </div>
          {sourceNote.includes('MONO') && <p className="text-xs font-semibold text-red-700">{sourceNote}</p>}
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(true)}
            className="border border-ink px-5 py-3 text-xs font-bold uppercase tracking-[0.15em] transition-colors hover:bg-paper disabled:opacity-50"
          >
            {state === 'testing' ? 'Checking…' : 'Soundcheck · 5s'}
          </button>
          <p className="text-xs text-muted">Local check only. Nothing goes on air.</p>
        </section>

        <section aria-labelledby="broadcast-heading" className="space-y-3">
          <h2 id="broadcast-heading" className="text-sm font-bold uppercase tracking-[0.16em]">Broadcast</h2>
          {!hasInvite && (
            <label className="block text-xs font-medium text-muted">
              Access code
              <input
                type="text"
                value={entryCode}
                disabled={busy}
                autoCapitalize="characters"
                autoComplete="off"
                onChange={(event) => setEntryCode(event.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 12))}
                placeholder="12-character code"
                className="mt-2 block w-full max-w-sm border border-stone-300 bg-white p-3 font-mono tracking-widest text-ink"
              />
            </label>
          )}

          {state === 'sending' ? (
            <button
              type="button"
              onClick={stop}
              className="w-full bg-accent-red py-4 text-sm font-bold uppercase tracking-[0.16em] text-white"
            >
              End broadcast
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void run(false)}
              disabled={!canBroadcast || busy}
              className="w-full bg-ink py-4 text-sm font-bold uppercase tracking-[0.16em] text-white transition-colors hover:bg-accent-red disabled:opacity-45"
            >
              {state === 'connecting' ? 'Connecting…' : 'Go live'}
            </button>
          )}

          <div role="status" aria-live="polite" className="space-y-1">
            <p className={'text-xs font-bold uppercase tracking-[0.15em] ' + (state === 'sending' ? 'text-accent-red' : 'text-muted')}>
              {state === 'sending' ? '● On air' : state === 'connecting' ? '● Connecting' : '● Off air'}
            </p>
            {state === 'error' && <p className="text-sm text-red-700">{message}</p>}
            {state === 'testing' && <p className="text-xs text-muted">Checking input…</p>}
            {state === 'sending' && (
              <p className="text-xs text-muted">
                {/slow|recover|interrupted/i.test(message) ? 'Connection is unstable. Check your internet.' : 'Keep this tab open during your set.'}
              </p>
            )}
            {state === 'sending' && publicStatus === 'unavailable' && (
              <p className="text-xs text-red-700">Listener stream not confirmed. Check from another device.</p>
            )}
          </div>

          {state === 'sending' && (
            <div className="flex items-start gap-3 border border-ink/15 bg-paper/70 p-3" role="status" aria-live="polite">
              <span
                aria-hidden="true"
                className={'mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ' +
                  (verification.phase === 'verified' ? 'bg-green-600'
                    : verification.phase === 'warning' || verification.phase === 'unavailable' ? 'bg-red-600'
                    : 'bg-amber-500')}
              />
              <div className="min-w-0 flex-1 space-y-1">
                <p className="text-sm font-bold">{verification.label}</p>
                {verification.phase === 'verified' && (
                  <p className="text-xs text-muted">
                    {verification.delayMs !== undefined ? (verification.delayMs / 1000).toFixed(1) + ' s listener delay' : ''}
                    {verification.matchPercent !== undefined ? ' · ' + verification.matchPercent + '% signal match' : ''}
                  </p>
                )}
                {(verification.phase === 'warning' || verification.phase === 'unavailable') && (
                  <p className="text-xs text-muted">{verification.detail}</p>
                )}
              </div>
              <button
                type="button"
                onClick={() => verifierRef.current?.retry()}
                disabled={!verifierRef.current}
                className="shrink-0 border border-ink/30 px-2.5 py-2 text-[10px] font-bold uppercase tracking-wider disabled:opacity-40"
              >
                Retry
              </button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {PUBLIC_STREAM_URL && (
              <a
                href={PUBLIC_STREAM_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="border border-ink/40 px-4 py-2.5 text-xs font-bold uppercase tracking-[0.12em] text-ink transition-colors hover:border-ink"
              >
                Open listener
              </a>
            )}
            <details className="min-w-0 text-xs text-muted">
              <summary className="cursor-pointer underline underline-offset-4">Connection details</summary>
              <div className="mt-3 space-y-2 border-l border-ink/20 pl-3">
                <p>{message}</p>
                {sourceNote && <p>{sourceNote}</p>}
                {state === 'sending' && verification.detail && <p>{verification.detail}</p>}
                <p>Verification uses the actual public MP3 stream, decoded silently. No test tone is injected into your set.</p>}
                {state === 'sending' && sent > 0 && (
                  <p>
                    {(sent / 1024 / 1024).toFixed(1)} MB sent
                    {latencyMs !== null ? ' · ' + latencyMs + ' ms round trip' : ''}
                    {pendingBytes !== null ? ' · ' + Math.round(pendingBytes / 1024) + ' KiB queued' : ''}
                  </p>
                )}
                {lastClose && <p className="text-red-700">Last disconnect: {lastClose}</p>}
                <p>
                  {publicStatus === 'available' ? 'Station stream responding.'
                    : publicStatus === 'checking' ? 'Checking station stream…'
                    : publicStatus === 'unavailable' ? 'Station stream not confirmed.'
                    : 'Use a second device to check what listeners hear.'}
                </p>
                {PUBLIC_STREAM_URL && (
                  <button
                    type="button"
                    onClick={() => void checkPublicStream()}
                    disabled={publicStatus === 'checking'}
                    className="border border-ink/30 px-3 py-2 font-bold uppercase tracking-wider disabled:opacity-50"
                  >
                    Check stream
                  </button>
                )}
              </div>
            </details>
          </div>
        </section>
      </div>
    </section>
  );
}
