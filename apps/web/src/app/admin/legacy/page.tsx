import { PublicShell } from '@/components/PublicShell';
import { AdminConsole } from '@/components/AdminConsole';

export const metadata = { title: 'Legacy admin · Virgo Boys Radio', robots: { index: false, follow: false } };

export default function LegacyAdminPage() {
  return <PublicShell><AdminConsole /></PublicShell>;
}
