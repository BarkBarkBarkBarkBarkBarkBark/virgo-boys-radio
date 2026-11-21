'use client';

/**
 * AudioProvider — global audio context for Virgo Boys Radio.
 *
 * All WebRTC / WebSocket / fallback-audio logic lives here so it survives
 * page navigation and feeds the persistent PlayerBar and vinyl glow.
 *
 * Always-on sync:
 *   The server maintains a scheduler (trackIndex + startedAt timestamp).
 *   Each station_status WS message includes alwaysOnState.  When we load a
 *   track we seek to (Date.now() - startedAt) / 1000 seconds so every listener
 *   hears the same moment in the same track — real radio behaviour.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { AlwaysOnPlaylist, SignalServerMessage, StationStatus } from '@virgo-boys-radio/shared';
import { API_BASE, getSignalUrl, apiFetch } from '@/lib/api';
import { PUBLIC_STREAM_URL, USE_ICECAST } from '@/lib/streamConfig';
import { sendStationTelemetry } from '@/lib/stationTelemetry';
import { getOrCreatePeerId } from '@/lib/peerId';

// ─── Public interface ────────────────────────────────────────────────────────

export interface AudioContextValue {
  transport: 'icecast' | 'webrtc';
  enabled: boolean;
  connected: boolean;
  message: string;
  status: StationStatus | null;
  playlist: AlwaysOnPlaylist | null;
  currentFallbackIndex: number;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  amplitude: number;
  setEnabled: (v: boolean) => void;
  handleTrackEnded: () => void;
  skipTrack: () => void;
}

const AudioCtx = createContext<AudioContextValue | null>(null);

export function useAudio(): AudioContextValue {
  const ctx = useContext(AudioCtx);
  if (!ctx) throw new Error('useAudio must be used inside <AudioProvider>');
  return ctx;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const rtcConfig: RTCConfiguration = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

function serializeCandidate(c: RTCIceCandidate) {
  return {
    candidate: c.candidate,
    sdpMid: c.sdpMid,
    sdpMLineIndex: c.sdpMLineIndex,
    usernameFragment: c.usernameFragment ?? null,
  };
}

function pickRandomIndex(length: number, exclude?: number): number {
  if (length <= 1) return 0;
  let next = Math.floor(Math.random() * length);
  if (exclude === undefined) return next;
  while (next === exclude) {
    next = Math.floor(Math.random() * length);
  }
  return next;
}

// ─── Provider ────────────────────────────────────────────────────────────────

function LegacyAudioProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus]             = useState<StationStatus | null>(null);
  const [playlist, setPlaylist]         = useState<AlwaysOnPlaylist | null>(null);
  const [enabled, setEnabledRaw]        = useState(false);
  const [message, setMessage]           = useState('Tap play to tune in.');
  const [peerId, setPeerId]             = useState('');
  const [connected, setConnected]       = useState(false);
  const [currentFallbackIndex, setCurrentFallbackIndex] = useState(0);
  const [amplitude, setAmplitude]       = useState(0);

  const wsRef             = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const peerRetryTimerRef = useRef<number | null>(null);
  const audioRef          = useRef<HTMLAudioElement | null>(null);
  const peerRef           = useRef<RTCPeerConnection | null>(null);
  const targetBroadRef    = useRef<string | null>(null);
  const enabledRef        = useRef(false);
  const fallbackModeRef   = useRef(false);
  // ICE candidates that arrive before setRemoteDescription resolves are
  // illegal to add and are silently dropped without buffering — that's the
  // most common cause of "WebRTC handshake completes but no audio" failures.
  const pendingIceRef     = useRef<RTCIceCandidateInit[]>([]);
  const remoteDescSetRef  = useRef(false);

  // Web Audio for amplitude polling
  const webAudioCtxRef  = useRef<AudioContext | null>(null);
  const analyserRef     = useRef<AnalyserNode | null>(null);
  const ampRafRef       = useRef<number | null>(null);

  // ── Web Audio setup ───────────────────────────────────────────────────────

  const ensureWebAudio = useCallback(() => {
    if (webAudioCtxRef.current || !audioRef.current) return;
    try {
      const ctx      = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize               = 256;
      analyser.smoothingTimeConstant = 0.82;
      const source = ctx.createMediaElementSource(audioRef.current);
      source.connect(analyser);
      analyser.connect(ctx.destination);
      webAudioCtxRef.current = ctx;
      analyserRef.current    = analyser;

      const data = new Uint8Array(analyser.frequencyBinCount);
      const poll = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += Math.abs(v - 128);
        setAmplitude(Math.min(1, (sum / data.length / 128) * 4));
        ampRafRef.current = requestAnimationFrame(poll);
      };
      ampRafRef.current = requestAnimationFrame(poll);
    } catch {
      // AudioContext unavailable
    }
  }, []);

  // ── setEnabled (public) ───────────────────────────────────────────────────

  const setEnabled = useCallback(
    (v: boolean) => {
      setEnabledRaw(v);
      if (v) ensureWebAudio();
    },
    [ensureWebAudio],
  );

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  useEffect(() => {
    setPeerId(getOrCreatePeerId('listener'));
    void Promise.all([
      apiFetch<StationStatus>('/public/status').then(setStatus),
      apiFetch<AlwaysOnPlaylist>('/public/autoplay').then(setPlaylist),
    ]).catch(() => setMessage('Unable to reach the control server right now.'));
  }, []);

  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  // ── Audio logic ───────────────────────────────────────────────────────────

  const closePeer = useCallback(() => {
    peerRef.current?.close();
    peerRef.current        = null;
    targetBroadRef.current = null;
    pendingIceRef.current  = [];
    remoteDescSetRef.current = false;
    if (peerRetryTimerRef.current !== null) {
      window.clearTimeout(peerRetryTimerRef.current);
      peerRetryTimerRef.current = null;
    }
    if (audioRef.current) audioRef.current.srcObject = null;
  }, []);

  const stopFallbackAudio = useCallback(() => {
    fallbackModeRef.current = false;
    if (!audioRef.current) return;
    audioRef.current.pause();
    audioRef.current.removeAttribute('src');
    audioRef.current.load();
  }, []);

  /** Load a fallback track by index for this listener session. */
  const playFallbackTrack = useCallback(
    async (index: number) => {
      if (!audioRef.current || !playlist?.tracks.length || !enabledRef.current) return;
      const norm  = index % playlist.tracks.length;
      const track = playlist.tracks[norm];
      if (!track) return;
      fallbackModeRef.current    = true;
      audioRef.current.srcObject = null;
      audioRef.current.volume    = 1;
      audioRef.current.src       = `${API_BASE}${track.url}`;
      audioRef.current.load();

      try {
        await audioRef.current.play();
        setCurrentFallbackIndex(norm);
        setMessage(`Now playing: ${track.title}`);
      } catch {
        setMessage(`Ready: ${track.title}. Tap play if autoplay is blocked.`);
      }
    },
    [playlist],
  );

  const ensureFallbackAudio = useCallback(
    async (force = false) => {
      if (!playlist?.tracks.length) { setMessage('No tracks available yet.'); return; }
      if (
        !force
        && fallbackModeRef.current
        && audioRef.current
        && !audioRef.current.paused
      ) {
        return;
      }
      const next = pickRandomIndex(playlist.tracks.length, currentFallbackIndex);
      await playFallbackTrack(next);
    },
    [currentFallbackIndex, playFallbackTrack, playlist],
  );

  const sendJson = useCallback((payload: unknown) => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify(payload));
  }, []);

  let connectRef: (() => void) | null = null;

  const scheduleReconnect = useCallback(() => {
    if (!enabledRef.current || reconnectTimerRef.current !== null) return;
    reconnectTimerRef.current = window.setTimeout(() => {
      reconnectTimerRef.current = null;
      connectRef?.();
    }, 2_000);
  }, []);

  const schedulePeerRetry = useCallback((broadcasterPeerId: string) => {
    if (peerRetryTimerRef.current !== null) return;
    peerRetryTimerRef.current = window.setTimeout(() => {
      peerRetryTimerRef.current = null;
      if (!enabledRef.current || targetBroadRef.current !== null) return;
      void startPeerConnectionRef.current?.(broadcasterPeerId);
    }, 2_000);
  }, []);

  const startPeerConnectionRef = useRef<((id: string) => Promise<void>) | null>(null);

  const startPeerConnection = useCallback(
    async (broadcasterPeerId: string) => {
      if (!peerId || !enabledRef.current) return;
      closePeer();
      setMessage('Connecting to the live stream…');

      const peer = new RTCPeerConnection(rtcConfig);
      peerRef.current        = peer;
      targetBroadRef.current = broadcasterPeerId;

      peer.ontrack = (event) => {
        const [stream] = event.streams;
        if (audioRef.current) {
          stopFallbackAudio();
          audioRef.current.srcObject = stream ?? new MediaStream([event.track]);
          audioRef.current.volume = 1;
          void audioRef.current.play().catch(() => {
            setMessage('Connected — tap play if audio is silent.');
          });
        }
        setMessage('You are listening live.');
        ensureWebAudio();
      };

      peer.onicecandidate = (event) => {
        if (!event.candidate) return;
        sendJson({
          type: 'ice_candidate',
          peerId,
          targetPeerId: broadcasterPeerId,
          candidate: serializeCandidate(event.candidate),
        });
      };

      peer.onconnectionstatechange = () => {
        if (peer.connectionState === 'failed' || peer.connectionState === 'disconnected') {
          setMessage('Connection dropped. Reconnecting…');
          closePeer();
          schedulePeerRetry(broadcasterPeerId);
        }
      };

      peer.addTransceiver('audio', { direction: 'recvonly' });
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      sendJson({ type: 'sdp_offer', peerId, targetPeerId: broadcasterPeerId, sdp: offer.sdp ?? '' });
    },
    [closePeer, ensureWebAudio, peerId, schedulePeerRetry, sendJson, stopFallbackAudio],
  );

  startPeerConnectionRef.current = startPeerConnection;

  const handleServerMessage = useCallback(
    async (payload: SignalServerMessage) => {
      if (payload.type === 'listener_accepted') {
        setConnected(true);
        setMessage('Connected. Waiting for a broadcaster…');
        return;
      }

      if (payload.type === 'station_status') {
        setStatus(payload);

        if (!payload.broadcasterPresent || !payload.broadcasterPeerId) {
          closePeer();
          if (enabledRef.current) {
            await ensureFallbackAudio();
          }
          return;
        }

        if (targetBroadRef.current !== payload.broadcasterPeerId) {
          await startPeerConnection(payload.broadcasterPeerId);
        }
        return;
      }

      if (payload.type === 'peer_answer' && peerRef.current) {
        await peerRef.current.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
        remoteDescSetRef.current = true;
        // Drain any ICE candidates that arrived before the answer landed —
        // adding them earlier would have thrown InvalidStateError.
        const queued = pendingIceRef.current;
        pendingIceRef.current = [];
        for (const c of queued) {
          try { await peerRef.current.addIceCandidate(c); } catch { /* ignore stale */ }
        }
        return;
      }

      if (payload.type === 'ice_candidate') {
        if (peerRef.current && remoteDescSetRef.current) {
          try { await peerRef.current.addIceCandidate(payload.candidate); } catch { /* ignore stale */ }
        } else {
          pendingIceRef.current.push(payload.candidate);
        }
        return;
      }

      if (payload.type === 'force_disconnect') {
        setMessage(payload.reason);
        closePeer();
      }
    },
    [closePeer, ensureFallbackAudio, startPeerConnection],
  );

  const connect = useCallback(() => {
    if (!enabledRef.current || !peerId) return;
    wsRef.current?.close();
    const ws = new WebSocket(getSignalUrl());
    wsRef.current = ws;

    ws.onopen = () => {
      setConnected(true);
      setMessage('Joining the listener room…');
      sendJson({ type: 'join_as_listener', peerId });
    };
    ws.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data as string) as SignalServerMessage;
        void handleServerMessage(payload);
      } catch {
        setMessage('Received an invalid server message.');
      }
    };
    ws.onclose = () => {
      setConnected(false);
      closePeer();
      scheduleReconnect();
    };
    ws.onerror = () => { setMessage('Signal link failed. Retrying…'); };
  }, [closePeer, handleServerMessage, peerId, scheduleReconnect, sendJson]);

  connectRef = connect;

  useEffect(() => {
    if (!enabled || !peerId) return;
    connect();
    return () => {
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (peerRetryTimerRef.current !== null) {
        window.clearTimeout(peerRetryTimerRef.current);
        peerRetryTimerRef.current = null;
      }
      sendJson({ type: 'leave', peerId });
      wsRef.current?.close();
      closePeer();
      stopFallbackAudio();
    };
  }, [enabled, peerId]); // intentionally minimal deps — connect is stable

  useEffect(() => {
    if (!enabled || !playlist?.tracks.length || status?.broadcasterPresent) return;
    void ensureFallbackAudio();
  }, [enabled, playlist, status?.broadcasterPresent]);

  const handleTrackEnded = useCallback(() => {
    if (!fallbackModeRef.current) return;
    if (!playlist?.tracks.length) return;
    const next = pickRandomIndex(playlist.tracks.length, currentFallbackIndex);
    void playFallbackTrack(next);
  }, [currentFallbackIndex, playFallbackTrack, playlist]);

  const skipTrack = useCallback(() => {
    if (status?.broadcasterPresent) {
      setMessage('Live broadcast is active. Skip is available when fallback tracks are on.');
      return;
    }
    if (!playlist?.tracks.length) return;
    const next = pickRandomIndex(playlist.tracks.length, currentFallbackIndex);
    void playFallbackTrack(next);
  }, [currentFallbackIndex, playFallbackTrack, playlist, status?.broadcasterPresent]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.volume = 1;
  }, []);

  useEffect(() => {
    return () => {
      if (ampRafRef.current !== null) cancelAnimationFrame(ampRafRef.current);
      webAudioCtxRef.current?.close().catch(() => {});
    };
  }, []);

  return (
    <AudioCtx.Provider
      value={{
        transport: 'webrtc',
        enabled,
        connected,
        message,
        status,
        playlist,
        currentFallbackIndex,
        audioRef,
        amplitude,
        setEnabled,
        handleTrackEnded,
        skipTrack,
      }}
    >
      <audio ref={audioRef} className="hidden" onEnded={handleTrackEnded} />
      {children}
    </AudioCtx.Provider>
  );
}


/**
 * Public radio transport: one HTTP audio connection per listener, delivered
 * by the Icecast host. Never use broadcaster-to-listener WebRTC fanout here.
 */
function IcecastAudioProvider({ children }: { children: React.ReactNode }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playingWanted = useRef(false);
  const retryTimer = useRef<number | null>(null);
  const stallTimer = useRef<number | null>(null);
  const attempts = useRef(0);
  const lastProgress = useRef({ time: 0, at: 0 });
  const [enabled, setEnabledState] = useState(false);
  const [connected, setConnected] = useState(false);
  const [message, setMessage] = useState('Tap Play to listen.');

  const clearTimers = useCallback(() => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    if (stallTimer.current !== null) window.clearTimeout(stallTimer.current);
    retryTimer.current = null;
    stallTimer.current = null;
  }, []);

  const retryRef = useRef<(() => void) | null>(null);
  const start = useCallback(() => {
    const audio = audioRef.current;
    if (!playingWanted.current || !audio) return;
    audio.src = PUBLIC_STREAM_URL;
    audio.load();
    sendStationTelemetry('listener', 'reconnecting', { phase: 'connecting', details: 'Starting public Icecast stream' }, audio);
    void audio.play().catch((cause: unknown) => {
      if (!playingWanted.current) return;
      const errorName = cause instanceof Error ? cause.name : 'unknown';
      sendStationTelemetry('listener', 'play_rejected', { phase: 'error', details: errorName }, audio);
      if (errorName === 'NotAllowedError') {
        // iOS needs another explicit tap; automatic retry cannot grant permission.
        playingWanted.current = false;
        setEnabledState(false);
        setConnected(false);
        setMessage('Tap Play to resume audio (browser permission required).');
      } else {
        retryTimer.current === null && window.setTimeout(() => {
          if (playingWanted.current) retryRef.current?.();
        }, 0);
        setMessage('Stream unavailable. Reconnecting…');
      }
    });
  }, []);

  const retry = useCallback(() => {
    if (!playingWanted.current || retryTimer.current !== null) return;
    const delay = Math.min(15000, 2000 * Math.pow(2, Math.min(attempts.current++, 3)));
    setMessage('Connection interrupted. Reconnecting…');
    sendStationTelemetry('listener', 'reconnect_scheduled', {
      phase: 'connecting', details: 'retry delay ' + delay + 'ms, attempt ' + attempts.current,
    }, audioRef.current);
    retryTimer.current = window.setTimeout(() => {
      retryTimer.current = null;
      start();
    }, delay);
  }, [start]);

  retryRef.current = retry;

  const setEnabled = useCallback((next: boolean) => {
    playingWanted.current = next;
    setEnabledState(next);
    clearTimers();
    if (next) {
      attempts.current = 0;
      lastProgress.current = { time: 0, at: Date.now() };
      setMessage('Connecting to high-quality radio…');
      sendStationTelemetry('listener', 'play_requested', { phase: 'connecting' }, audioRef.current);
      start(); // Initiate play during the user's click gesture for mobile browsers.
    } else {
      audioRef.current?.pause();
      audioRef.current?.removeAttribute('src');
      audioRef.current?.load();
      setConnected(false);
      sendStationTelemetry('listener', 'pause', { phase: 'paused', details: 'User stopped playback' }, audioRef.current);
      setMessage('Paused. Tap Play to listen.');
    }
  }, [clearTimers, start]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onPlaying = () => {
      clearTimers();
      attempts.current = 0;
      lastProgress.current = { time: audio.currentTime, at: Date.now() };
      setConnected(true);
      setMessage('Connected to radio.');
      sendStationTelemetry('listener', 'playing', { phase: 'playing' }, audio);
    };
    const onBuffer = () => {
      if (!playingWanted.current) return;
      setConnected(false);
      setMessage('Buffering high-quality audio…');
      sendStationTelemetry('listener', 'waiting', { phase: 'buffering' }, audio);
      if (stallTimer.current === null) {
        stallTimer.current = window.setTimeout(() => {
          stallTimer.current = null;
          if (playingWanted.current && audio.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) retry();
        }, 12000);
      }
    };
    const onStalled = () => {
      sendStationTelemetry('listener', 'stalled', { phase: 'buffering', details: 'Media download stalled' }, audio);
      onBuffer();
    };
    const onError = () => {
      setConnected(false);
      sendStationTelemetry('listener', 'error', {
        phase: 'error', details: 'Media error ' + (audio.error?.code ?? 'unknown'),
      }, audio);
      retry();
    };
    const onEnded = () => {
      sendStationTelemetry('listener', 'ended', { phase: 'stopped' }, audio);
      onError();
    };
    const onPause = () => {
      setConnected(false);
      if (playingWanted.current) {
        sendStationTelemetry('listener', 'pause', { phase: 'buffering', details: 'Unexpected media pause' }, audio);
        retry(); // A media element can pause with seconds buffered and never emit an error.
      }
    };
    const heartbeat = window.setInterval(() => {
      if (!playingWanted.current) return;
      const now = Date.now();
      if (!audio.paused && !audio.ended && audio.currentTime > lastProgress.current.time + 0.15) {
        lastProgress.current = { time: audio.currentTime, at: now };
      } else if (!audio.paused && now - lastProgress.current.at > 8000 && retryTimer.current === null) {
        sendStationTelemetry('listener', 'playback_progress_stalled', {
          phase: 'buffering', details: 'Playhead has not advanced for 8 seconds',
        }, audio);
        retry();
      }
      sendStationTelemetry('listener', 'heartbeat', {
        phase: audio.paused ? 'buffering' : audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA ? 'playing' : 'buffering',
        details: 'Media element state snapshot',
      }, audio);
    }, 2000);
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('waiting', onBuffer);
    audio.addEventListener('stalled', onStalled);
    audio.addEventListener('error', onError);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('pause', onPause);
    return () => {
      clearTimers();
      window.clearInterval(heartbeat);
      audio.pause();
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('waiting', onBuffer);
      audio.removeEventListener('stalled', onStalled);
      audio.removeEventListener('error', onError);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('pause', onPause);
    };
  }, [clearTimers, retry]);

  return (
    <AudioCtx.Provider value={{
      transport: 'icecast',
      enabled,
      connected,
      message,
      status: null, // Legacy room status is not the live Icecast listener count.
      playlist: null,
      currentFallbackIndex: 0,
      audioRef,
      amplitude: 0, // Never risk Web Audio silence on a cross-origin stream.
      setEnabled,
      handleTrackEnded: () => {},
      skipTrack: () => {},
    }}>
      <audio ref={audioRef} preload="none" className="hidden" />
      {children}
    </AudioCtx.Provider>
  );
}

export function AudioProvider({ children }: { children: React.ReactNode }) {
  return USE_ICECAST
    ? <IcecastAudioProvider>{children}</IcecastAudioProvider>
    : <LegacyAudioProvider>{children}</LegacyAudioProvider>;
}
