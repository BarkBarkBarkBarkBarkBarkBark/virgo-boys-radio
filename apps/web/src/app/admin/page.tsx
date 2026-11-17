import { PublicShell } from '@/components/PublicShell';
import { AdminConsole } from '@/components/AdminConsole';

export const metadata = { title: 'Admin · Virgo Boys Radio' };

export default function AdminPage() {
  return (
    <PublicShell>
      <AdminConsole />
    </PublicShell>
  );
}
