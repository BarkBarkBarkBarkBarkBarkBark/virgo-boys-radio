import { PublicShell } from '@/components/PublicShell';
import { PrivateDjBooth } from '@/components/PrivateDjBooth';

export const metadata = {
  title: 'Private DJ Booth · Virgo Boys Radio',
  description: 'Private, browser-based DJ broadcast connection.',
  robots: { index: false, follow: false },
};

export default function PrivateDjPage() {
  return <PublicShell><PrivateDjBooth /></PublicShell>;
}
