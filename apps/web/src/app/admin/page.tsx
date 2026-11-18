import { PublicShell } from '@/components/PublicShell';
import { OperationsDashboard } from '@/components/OperationsDashboard';

export const metadata = { title: 'Broadcast monitor · Virgo Boys Radio', robots: { index: false, follow: false } };

export default function AdminPage() {
  return <PublicShell><OperationsDashboard /></PublicShell>;
}
