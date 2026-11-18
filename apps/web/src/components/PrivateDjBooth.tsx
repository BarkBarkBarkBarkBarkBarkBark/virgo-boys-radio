'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '@/lib/api';
import { PUBLIC_STREAM_URL } from '@/lib/streamConfig';

type AudioSource = 'tone' | 'tab' | 'interface';
type BoothState = 'idle' | 'testing' | 'connecting' | 'sending' | 'error';
type Meter = { left: number; right: number };

const SOURCES: { id: AudioSource; name: string; description: string }[] = [
  { id: 'tone', name: 'Built-in test audio', description: 'Generate 440 Hz in the left channel and 660 Hz in the right channel. No equipment needed.' },
  { id: 'tab', name: 'Browser tab audio', description: 'Share another browser tab with audio. Use content you have permission to broadcast.' },
  { id: 'interface', name: 'Mixer or audio interface', description: 'Use stereo USB input, or a system monitor/loopback input if your computer offers one.' },
];

export function PrivateDjBooth() {
  const [hasInvite, setHasInvite] = useState(false);
  const [entryCode, setEntryCode] = useState('');
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [pendingBytes, setPendingBytes] = useState<number | null>(null);
  const [lastClose, setLastClose] = useState('');
  const [source, setSource] = useState<AudioSource>('tone');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [state, setState] = useState<BoothState>('idle');
  const [message, setMessage] = useState('Select an audio source, then test it locally.');
  const [meter, setMeter] = useState<Meter>({ left: 0, right: 0 });
  const [sourceNote, setSourceNote] = useState('');
  const [sent, setSent] = useState(0);
  const [publicStatus, setPublicStatus] = useState<'idle' | 'checking' | 'available' | 'unavailable'>('idle');
  const inviteRef = useRef('');
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const oscillatorsRef = useRef<OscillatorNode[]>([]);
  const meterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const testTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const checkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);

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
    const socket = wsRef.current;
    wsRef.current = null;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) socket.close();
    if (meterTimerRef.current) clearInterval(meterTimerRef.current);
    if (testTimerRef.current) clearTimeout(testTimerRef.current);
    if (checkTimerRef.current) clearTimeout(checkTimerRef.current);
    if (heartbeatRef.current) clearInterval(heartbeatRef.current);
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
    setState('idle');
    setPublicStatus('idle');
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
    setSourceNote('');
    setLatencyMs(null);
    setPendingBytes(null);
    setLastClose('');
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

      const socket = new WebSocket(API_BASE.replace(/^http/i, 'ws').replace(/\/$/, '') + '/dj/pcm');
      wsRef.current = socket;
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'auth', ...(hasInvite ? { token: inviteRef.current } : { code: entryCode }) }));
        setMessage('Authenticating private DJ invitation…');
      };
      socket.onmessage = (event) => {
        let reply: { type: string; message?: string; bytesReceived?: number; pendingBytes?: number; clientTime?: number; serverTime?: number };
        try { reply = JSON.parse(event.data as string) as typeof reply; } catch { return; }
        if (reply.type === 'ready') {
          worklet.port.onmessage = (frame) => {
            if (socket.readyState !== WebSocket.OPEN) return;
            if (socket.bufferedAmount > 512 * 1024) {
              setMessage('Network uplink is falling behind. Transmission disconnected.');
              socket.close();
              return;
            }
            socket.send(frame.data as ArrayBuffer);
          };
          input.connect(worklet);
          heartbeatRef.current = setInterval(() => {
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'heartbeat', clientTime: Date.now() }));
          }, 5000);
          setState('sending');
          setMessage('Audio is flowing to Fly. Keep this tab foregrounded; verify the listener feed on another device.');
          checkTimerRef.current = setTimeout(() => void checkPublicStream(), 3000);
        } else if (reply.type === 'stats') {
          setSent(reply.bytesReceived ?? 0);
          setPendingBytes(reply.pendingBytes ?? null);
        } else if (reply.type === 'heartbeat' && reply.clientTime) {
          setLatencyMs(Math.max(0, Date.now() - reply.clientTime));
        } else if (reply.type === 'error') {
          setMessage(reply.message ?? 'The station rejected this connection.');
          setState('error');
          cleanup();
        }
      };
      socket.onerror = () => {
        setMessage('WebSocket error: network, reverse proxy, or backend failure. Check the admin disconnect log.');
        setState('error');
        cleanup();
      };
      socket.onclose = (event) => {
        if (wsRef.current !== socket) return;
        const reason = 'WebSocket closed (' + event.code + ', ' + (event.wasClean ? 'clean' : 'unclean') + ')' + (event.reason ? ': ' + event.reason : '');
        setLastClose(reason);
        setMessage(reason + '. Check the admin dashboard for server-side cause.');
        setState('error');
        cleanup();
      };
    } catch (error) {
      cleanup();
      setState('error');
      setMessage(error instanceof Error ? error.message : 'Audio source could not be opened.');
    }
  };

  const busy = state === 'testing' || state === 'connecting' || state === 'sending';
  const canBroadcast = hasInvite || /^[A-HJ-NP-Z2-9]{12}$/.test(entryCode);
  const meterPercent = (value: number) => Math.min(100, Math.round(Math.max(0, value) * 100));

  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-3">
        <p className="text-xs font-mono uppercase tracking-[0.3em] text-muted">Virgo Boys Radio / DJ booth</p>
        <h1 className="text-4xl font-bold uppercase tracking-[0.08em]">Play audio. Go live.</h1>
        <p className="text-sm text-muted">No encoder to install. Generate a test signal, share a browser tab, or capture your audio interface.</p>
      </div>

      <div className="border border-stone-300 bg-white/85 p-5 sm:p-7 space-y-6">
        <div className="space-y-3">
          <h2 className="text-xl font-bold">1. Choose where the sound comes from</h2>
          <div className="grid gap-2 md:grid-cols-3">
            {SOURCES.map((item) => (
              <button type="button" key={item.id} disabled={busy}
                onClick={() => { setSource(item.id); setState('idle'); setMessage('Source selected. Run a local test or go live.'); setMeter({ left: 0, right: 0 }); }}
                className={'text-left border p-4 transition-colors disabled:opacity-60 ' +
                  (source === item.id ? 'border-ink bg-stone-100' : 'border-stone-300 hover:border-ink')}>
                <span className="block font-bold text-sm">{item.name}</span>
                <span className="block text-xs mt-2 text-muted leading-5">{item.description}</span>
              </button>
            ))}
          </div>
          {source === 'interface' && (
            <label className="block text-xs text-muted">Audio input
              <select value={deviceId} disabled={busy} onChange={(event) => setDeviceId(event.target.value)}
                className="mt-2 w-full border border-stone-300 p-3 bg-white text-sm text-ink">
                <option value="">System default input</option>
                {devices.map((device) => (
                  <option key={device.deviceId} value={device.deviceId}>
                    {device.label || 'Audio input ' + device.deviceId.slice(0, 6)}
                  </option>
                ))}
              </select>
              <span className="block mt-2">A &quot;Monitor of …&quot; input can capture your computer&apos;s playback, while a physical interface input captures the connected mixer.</span>
            </label>
          )}
          {source === 'tab' && (
            <p className="text-xs text-muted leading-5">Chrome or Edge recommended. Choose the tab playing audio and enable <strong>Share tab audio</strong> when prompted. The site sends audio only; no screen video is transmitted. Sharing protected media may not work.</p>
          )}
          {source === 'tone' && (
            <p className="text-xs text-muted">The booth generates separate left/right tones internally. No microphone, mixer or YouTube needed.</p>
          )}
        </div>

        <div className="space-y-3">
          <h2 className="text-xl font-bold">2. Test the stereo source</h2>
          <div className="space-y-2">
            {(['left', 'right'] as const).map((side) => (
              <div key={side} className="flex items-center gap-3 text-xs">
                <span className="w-8 font-mono uppercase font-bold">{side === 'left' ? 'L' : 'R'}</span>
                <div className="flex-1 h-3 bg-stone-200">
                  <div className={'h-full transition-all ' + (meter[side] >= 0.99 ? 'bg-red-600' : 'bg-ink')}
                    style={{ width: meterPercent(meter[side]) + '%' }} />
                </div>
                <span className="w-11 text-right font-mono">{meterPercent(meter[side])}%</span>
              </div>
            ))}
          </div>
          {sourceNote && <p className="text-xs text-muted">{sourceNote}</p>}
          <button type="button" disabled={busy} onClick={() => void run(true)}
            className="border border-ink px-5 py-3 text-xs font-bold uppercase tracking-widest disabled:opacity-50">
            {state === 'testing' ? 'Testing…' : 'Test source locally (5 seconds)'}
          </button>
          <p className="text-xs text-muted">This meter check never transmits audio. The Go Live step is the end-to-end broadcast test.</p>
        </div>

        <div className="space-y-3">
          <h2 className="text-xl font-bold">3. Go live and listen</h2>
          {!hasInvite && (
            <label className="block text-sm text-muted">DJ access code
              <input type="text" value={entryCode} disabled={busy} autoCapitalize="characters" autoComplete="off"
                onChange={(event) => setEntryCode(event.target.value.toUpperCase().replace(/[^A-HJ-NP-Z2-9]/g, '').slice(0, 12))}
                placeholder="12-character guest passcode"
                className="block mt-2 w-full max-w-sm border border-stone-300 bg-white p-3 text-ink font-mono tracking-widest" />
              <span className="block mt-2 text-xs">Or open a private magic link from the operator. Local audio tests do not require a code.</span>
            </label>
          )}
          {state === 'sending' ? (
            <button type="button" onClick={stop}
              className="w-full rounded-lg bg-red-700 text-white py-5 font-bold uppercase tracking-[0.15em]">Stop broadcast</button>
          ) : (
            <button type="button" onClick={() => void run(false)} disabled={!canBroadcast || busy}
              className="w-full rounded-lg bg-ink text-white py-5 font-bold uppercase tracking-[0.15em] disabled:opacity-45">
              {state === 'connecting' ? 'Connecting…' : 'Go live'}
            </button>
          )}
          <div role="status" aria-live="polite" className="space-y-1 text-sm">
            <p className={state === 'sending' ? 'font-bold text-red-700' : 'font-semibold text-muted'}>
              {state === 'sending' ? '● TRANSMITTING' : state === 'connecting' ? '● CONNECTING' : '● OFF AIR'}
            </p>
            <p className="text-muted">{message}</p>
            {state === 'sending' && sent > 0 && <p className="text-xs text-muted">{(sent / 1024 / 1024).toFixed(1)} MB received by Fly. {latencyMs !== null ? 'Round-trip ' + latencyMs + ' ms. ' : ''}{pendingBytes !== null ? 'Encoder queue ' + Math.round(pendingBytes / 1024) + ' KiB.' : ''}</p>}
            {lastClose && <p className="text-xs text-red-700">Last drop: {lastClose}</p>}
          </div>
          <div className="border-t border-stone-200 pt-4 space-y-2">
            <p className="text-xs font-bold uppercase tracking-wider">Public listening check</p>
            {!PUBLIC_STREAM_URL ? <p className="text-xs text-amber-800">Station stream URL has not been set in Vercel yet.</p> : (
              <>
                <p className="text-sm">
                  {publicStatus === 'available' ? '✓ Stream endpoint responds with HTTP 200 (audio playback still needs a listening check).'
                    : publicStatus === 'checking' ? 'Checking the public stream…'
                    : publicStatus === 'unavailable' ? 'No live stream confirmed. If the DJ is connected, retry in a few seconds.'
                    : 'When live, the test will check that Icecast is available.'}
                </p>
                <div className="flex flex-wrap gap-3">
                  <button type="button" onClick={() => void checkPublicStream()} disabled={publicStatus === 'checking'}
                    className="border border-stone-400 px-4 py-2 text-xs uppercase font-bold disabled:opacity-50">Recheck stream</button>
                  <a href={PUBLIC_STREAM_URL} target="_blank" rel="noopener noreferrer"
                    className="border border-stone-400 px-4 py-2 text-xs uppercase font-bold">Open listener</a>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      <p className="text-xs text-muted leading-5">Keep the browser open throughout the broadcast and verify on another device. Wired internet is preferred for a live set. Never share the private invitation publicly.</p>
    </section>
  );
}
