'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '@/lib/api';

type BoothState = 'idle' | 'connecting' | 'sending' | 'error';
type Meter = { left: number; right: number };

export function PrivateDjBooth() {
  const [hasInvite, setHasInvite] = useState(false);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState('');
  const [state, setState] = useState<BoothState>('idle');
  const [message, setMessage] = useState('Choose your audio interface, then connect.');
  const [meter, setMeter] = useState<Meter>({ left: 0, right: 0 });
  const [channels, setChannels] = useState('');
  const [sent, setSent] = useState(0);
  const inviteRef = useRef('');
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const meterTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshDevices = useCallback(async () => {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      setDevices((await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'));
    } catch {
      // Device labels require permission in many browsers.
    }
  }, []);

  useEffect(() => {
    const invite = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
    if (/^[0-9a-f]{64}$/i.test(invite)) {
      inviteRef.current = invite;
      setHasInvite(true);
    }
    void refreshDevices();
    navigator.mediaDevices?.addEventListener?.('devicechange', refreshDevices);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refreshDevices);
  }, [refreshDevices]);

  const cleanup = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
    if (meterTimerRef.current) clearInterval(meterTimerRef.current);
    meterTimerRef.current = null;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (contextRef.current) void contextRef.current.close();
    contextRef.current = null;
    setMeter({ left: 0, right: 0 });
  }, []);

  useEffect(() => () => cleanup(), [cleanup]);

  const stop = () => {
    cleanup();
    setState('idle');
    setMessage('Disconnected. Your audio is no longer being transmitted.');
  };

  const connect = async () => {
    if (!hasInvite || state === 'connecting' || state === 'sending') return;
    cleanup();
    setState('connecting');
    setMessage('Checking your audio interface…');
    setSent(0);
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;

    try {
      if (!navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
        throw new Error('Use an up-to-date desktop Chrome, Edge, Firefox or Safari with HTTPS and microphone permission.');
      }
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
      streamRef.current = stream;
      await refreshDevices();
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('No audio input was returned by the browser.');
      const detectedChannels = track.getSettings().channelCount;
      setChannels(detectedChannels === 1 ? 'Browser reports mono. Select a stereo interface for best quality.'
        : detectedChannels === 2 ? 'Stereo input detected.' : 'Verify that both left and right inputs are present.');

      context = new AudioContext({ sampleRate: 48000 });
      contextRef.current = context;
      await context.audioWorklet.addModule('/dj-pcm-processor.js');
      await context.resume();

      const input = context.createMediaStreamSource(stream);
      const splitter = context.createChannelSplitter(2);
      const leftMeter = context.createAnalyser();
      const rightMeter = context.createAnalyser();
      leftMeter.fftSize = 2048;
      rightMeter.fftSize = 2048;
      input.connect(splitter);
      splitter.connect(leftMeter, 0);
      splitter.connect(rightMeter, 1);
      const leftBuffer = new Float32Array(2048);
      const rightBuffer = new Float32Array(2048);
      meterTimerRef.current = setInterval(() => {
        leftMeter.getFloatTimeDomainData(leftBuffer);
        rightMeter.getFloatTimeDomainData(rightBuffer);
        let left = 0;
        let right = 0;
        for (let n = 0; n < leftBuffer.length; n += 1) {
          left = Math.max(left, Math.abs(leftBuffer[n] ?? 0));
          right = Math.max(right, Math.abs(rightBuffer[n] ?? 0));
        }
        setMeter({ left, right });
      }, 150);

      const worklet = new AudioWorkletNode(context, 'virgo-pcm', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [2],
      });
      const zeroGain = context.createGain();
      zeroGain.gain.value = 0;
      worklet.connect(zeroGain).connect(context.destination);

      const wsUrl = API_BASE.replace(/^http/i, 'ws').replace(/\/$/, '') + '/dj/pcm';
      const socket = new WebSocket(wsUrl);
      wsRef.current = socket;
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        socket.send(JSON.stringify({ type: 'auth', token: inviteRef.current }));
        setMessage('Authenticating private invitation…');
      };
      socket.onmessage = (event) => {
        let reply: { type: string; message?: string; bytesReceived?: number };
        try { reply = JSON.parse(event.data as string) as typeof reply; } catch { return; }
        if (reply.type === 'ready') {
          worklet.port.onmessage = (frame) => {
            if (socket.readyState !== WebSocket.OPEN) return;
            if (socket.bufferedAmount > 512 * 1024) {
              setMessage('The network is not keeping up. Disconnecting to prevent audio delay.');
              socket.close();
              return;
            }
            socket.send(frame.data as ArrayBuffer);
          };
          input.connect(worklet);
          setState('sending');
          setMessage('Audio is being sent to the station. Confirm actual playback on a second device.');
        } else if (reply.type === 'stats') {
          setSent(reply.bytesReceived ?? 0);
        } else if (reply.type === 'error') {
          setMessage(reply.message ?? 'The station rejected this connection.');
          setState('error');
          cleanup();
        }
      };
      socket.onerror = () => {
        setMessage('Unable to reach the broadcast server. Check your connection.');
        setState('error');
        cleanup();
      };
      socket.onclose = (event) => {
        if (wsRef.current !== socket) return;
        setMessage(event.reason || 'Broadcast disconnected. Ask the station operator to check the stream.');
        setState('error');
        cleanup();
      };
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      if (context) void context.close();
      cleanup();
      setState('error');
      setMessage(error instanceof Error ? error.message : 'Unable to open the DJ booth.');
    }
  };

  const meterPercent = (value: number) => Math.min(100, Math.round(Math.max(0, value) * 100));
  return (
    <div className="mx-auto max-w-2xl space-y-7">
      <div className="space-y-3">
        <p className="text-xs uppercase font-mono tracking-[0.3em] text-muted">Private DJ access</p>
        <h1 className="text-4xl font-bold uppercase tracking-wide">You're in the booth.</h1>
        <p className="text-sm text-muted">Connect your mixer to a stereo USB audio interface. No broadcasting software to install.</p>
      </div>

      {!hasInvite ? (
        <div className="border border-stone-300 bg-white/80 p-6">
          <h2 className="font-bold text-xl">Private invitation required</h2>
          <p className="mt-2 text-sm text-muted">Ask the Virgo Boys Radio operator for a private DJ link. This page cannot broadcast without one.</p>
        </div>
      ) : (
        <div className="border border-stone-300 bg-white/80 p-6 space-y-6">
          <div>
            <label htmlFor="dj-device" className="block text-sm font-semibold">1. Select audio input</label>
            <select id="dj-device" value={deviceId} disabled={state === 'sending' || state === 'connecting'}
              onChange={(event) => setDeviceId(event.target.value)}
              className="mt-2 w-full bg-white border border-stone-300 p-3 text-ink text-sm">
              <option value="">System default input</option>
              {devices.map((d) => <option key={d.deviceId} value={d.deviceId}>{d.label || 'Audio input ' + d.deviceId.slice(0, 6)}</option>)}
            </select>
            <p className="text-xs text-muted mt-2">Give this page microphone permission when prompted, then choose your Scarlett, Steinberg or mixer interface. Keep gain below clipping.</p>
          </div>

          <div className="space-y-2">
            <p className="font-semibold text-sm">2. Stereo input</p>
            {(['left', 'right'] as const).map((side) => (
              <div key={side} className="flex items-center gap-3 text-xs">
                <span className="w-6 font-mono uppercase">{side === 'left' ? 'L' : 'R'}</span>
                <div className="flex-1 h-3 bg-stone-200">
                  <div className={'h-full transition-all ' + (meter[side] > 0.98 ? 'bg-red-600' : 'bg-ink')}
                    style={{ width: meterPercent(meter[side]) + '%' }} />
                </div>
                <span className="w-10 text-right font-mono">{meterPercent(meter[side])}%</span>
              </div>
            ))}
            {channels && <p className="text-xs text-muted">{channels}</p>}
          </div>

          <div className="space-y-3">
            <p className="font-semibold text-sm">3. Broadcast</p>
            {state === 'sending' ? (
              <button type="button" onClick={stop}
                className="w-full rounded-lg bg-red-700 text-white py-5 font-bold uppercase tracking-[0.15em]">Stop broadcast</button>
            ) : (
              <button type="button" onClick={() => void connect()} disabled={state === 'connecting'}
                className="w-full rounded-lg bg-ink text-white py-5 font-bold uppercase tracking-[0.15em] disabled:opacity-50">
                {state === 'connecting' ? 'Connecting…' : 'Go live'}
              </button>
            )}
            <div role="status" aria-live="polite" className="text-sm text-muted">
              <span className={state === 'sending' ? 'text-red-700 font-bold' : 'font-semibold'}>
                {state === 'sending' ? '● TRANSMITTING' : state === 'connecting' ? '● CONNECTING' : '● OFF AIR'}
              </span>
              <p className="mt-1">{message}</p>
            </div>
            {state === 'sending' && (
              <p className="text-xs text-muted">Uplink: 48 kHz stereo PCM. Server encodes 320 kbps MP3. {sent > 0 ? 'Data confirmed by server: ' + (sent / 1024 / 1024).toFixed(1) + ' MB' : ''}</p>
            )}
          </div>
        </div>
      )}
      <p className="text-xs text-muted">Keep this browser tab open throughout the set. Wired internet is preferred. A second phone should independently verify the public listening feed before the set begins. Private invitations are confidential and must not be shared.</p>
    </div>
  );
}
