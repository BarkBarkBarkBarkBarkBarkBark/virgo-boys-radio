import { PublicShell } from '@/components/PublicShell';
import EventsPageClient from './EventsPageClient';

export const metadata = { title: 'Events · Virgo Boys Radio' };

export default function EventsPage() {
  return (
    <PublicShell>
      <EventsPageClient />
    </PublicShell>
  );
}
