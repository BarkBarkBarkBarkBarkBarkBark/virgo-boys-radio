'use client';

import { useEffect, useRef, useState } from 'react';
import { PUBLIC_STREAM_URL, USE_ICECAST } from '@/lib/streamConfig';

type CheckState = 'idle' | 'checking' | 'ready' | 'inconclusive' | 'failed';

/** Checks media loading and decoding on this device; not a bitrate/throughput test. */
export function ConnectionCheck() {
  const [state, setState] = useState<CheckState>('idle');
  const [detail, setDetail] = useState('');
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  const test = () => {
    stopRef.current?.();
    if (!USE_ICECAST) {
      setState('failed');
      setDetail('No public station stream is configured.');
      return;
    }
    if (window.location.protocol === 'https:' && PUBLIC_STREAM_URL.startsWith('http:')) {
      setState('failed');
      setDetail('Secure HTTPS pages require an HTTPS stream. Ask the station operator to configure TLS.');
      return;
    }
    const probe = new Audio();
    probe.preload = 'auto';
    probe.muted = true;
    let finished = false;
    let timer: number | null = null;
    const cleanup = () => {
      if (timer !== null) window.clearTimeout(timer);
      probe.removeEventListener('canplay', onReady);
      probe.removeEventListener('loadeddata', onReady);
      probe.removeEventListener('error', onError);
      probe.pause();
      probe.removeAttribute('src');
      probe.load();
    };
    const finish = (next: CheckState, message: string) => {
      if (finished) return;
      finished = true;
      cleanup();
      stopRef.current = null;
      setState(next);
      setDetail(message);
    };
    const onReady = () => finish('ready', 'This browser reached and decoded the station audio. Press Play to listen.');
    const onError = () => finish('failed', 'Audio could not load or decode. The stream might be offline or incompatible with this device.');
    stopRef.current = cleanup;
    setState('checking');
    setDetail('Checking radio playback from this device…');
    probe.addEventListener('canplay', onReady);
    probe.addEventListener('loadeddata', onReady);
    probe.addEventListener('error', onError);
    timer = window.setTimeout(() => finish('inconclusive', 'No confirmation within 10 seconds. Some mobile browsers limit preloading; try Play.'), 10000);
    probe.src = PUBLIC_STREAM_URL;
    probe.load();
  };

  return (
    <div className="flex flex-col items-center gap-2 text-center" aria-live="polite">
      <button type="button" onClick={test} disabled={state === 'checking'}
        className="border border-ink/40 px-4 py-2 text-[11px] font-bold uppercase tracking-[0.18em] text-ink hover:border-accent-red hover:text-accent-red disabled:opacity-50">
        {state === 'checking' ? 'Checking…' : 'Test listening connection'}
      </button>
      {detail && <p className="max-w-md text-xs text-muted">{detail}</p>}
      <p className="max-w-md text-[10px] text-muted">
        Tests reachability and decoding, not actual stream bitrate, fidelity, or future uptime.
      </p>
    </div>
  );
}
