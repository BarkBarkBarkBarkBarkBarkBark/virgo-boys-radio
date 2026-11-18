import { PublicShell } from '@/components/PublicShell';
import { PrivateDjBooth } from '@/components/PrivateDjBooth';

export const metadata = {
  title: 'Broadcast booth · Virgo Boys Radio',
  description: 'Test and broadcast stereo audio from your browser.',
  robots: { index: false, follow: false },
};

export default function StreamPage() {
  return (
    <PublicShell>
      <PrivateDjBooth />
    </PublicShell>
  );
}
