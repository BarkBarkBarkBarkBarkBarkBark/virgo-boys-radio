import { PublicShell } from '@/components/PublicShell';
import { StreamClient } from '@/components/StreamClient';
import { DJReadiness } from '@/components/DJReadiness';
import { USE_ICECAST } from '@/lib/streamConfig';

export const metadata = { title: 'Broadcast booth · Virgo Boys Radio' };

export default function StreamPage() {
  return (
    <PublicShell>
      <DJReadiness />
      {!USE_ICECAST && <details className="mt-8 border border-stone-300 bg-white/80 p-6">
        <summary className="cursor-pointer font-bold">Experimental browser WebRTC room (not Icecast)</summary>
        <p className="my-4 text-xs text-muted">This mode does not feed Icecast. Use a dedicated encoder for the public station.</p>
        <StreamClient />
      </details>}
    </PublicShell>
  );
}
