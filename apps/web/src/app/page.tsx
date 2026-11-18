'use client';

import { Header } from '@/components/Header';
import { VinylRecord } from '@/components/VinylRecord';
import { useAudio } from '@/lib/AudioProvider';

export default function HomePage() {
  const { status, amplitude, enabled, connected, setEnabled, playlist, currentFallbackIndex, skipTrack, transport } = useAudio();
  const isLive = status?.stationState === 'live';
  const currentTrack = playlist?.tracks[currentFallbackIndex];

  return (
    <div className="home-stage flex flex-col bg-paper text-ink">
      <Header />

      <main className="flex w-full flex-1 flex-col items-center justify-center gap-4 px-4 py-4 text-center sm:gap-6 sm:py-8">
        <p className="flex items-center justify-center gap-2 text-[10px] font-mono font-semibold uppercase tracking-[0.3em] text-muted">
          {isLive && <span className="h-1.5 w-1.5 rounded-full bg-accent-red" aria-hidden="true" />}
          {isLive ? 'Live now' : 'Independent radio'}
        </p>

        <div className="home-vinyl shrink-0">
          <VinylRecord
            isLive={isLive}
            amplitude={amplitude}
            isPlaying={enabled}
            sizeClassName="aspect-square w-full"
          />
        </div>

        <div className="flex flex-col items-center gap-2">
          <div className="flex flex-wrap items-center justify-center gap-3">
            <button
              type="button"
              onClick={() => setEnabled(!enabled)}
              className="min-w-36 border border-ink bg-ink px-9 py-3.5 text-xs font-bold uppercase tracking-[0.25em] text-paper transition-colors hover:border-accent-red hover:bg-accent-red focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ink"
            >
              {enabled ? 'Pause' : 'Listen'}
            </button>

            {transport === 'webrtc' && (
              <button
                type="button"
                onClick={skipTrack}
                className="border border-ink/40 px-5 py-3.5 text-xs font-bold uppercase tracking-[0.2em] text-ink transition-colors hover:border-accent-red hover:text-accent-red"
              >
                Skip
              </button>
            )}
          </div>
          <p role="status" className="h-4 max-w-[80vw] truncate text-xs text-muted">
            {transport === 'webrtc' ? currentTrack?.title : enabled && !connected ? 'Connecting…' : ''}
          </p>
        </div>
      </main>
    </div>
  );
}
