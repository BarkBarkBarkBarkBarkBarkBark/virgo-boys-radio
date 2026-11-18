'use client';

import { useState, type FormEvent } from 'react';
import { PublicShell } from '@/components/PublicShell';

export default function AdminLoginPage() {
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const signIn = async (event: FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      const response = await fetch('/api/ops/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }), cache: 'no-store',
      });
      const result = await response.json() as { ok?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Unable to sign in');
      setPassword('');
      window.location.assign('/admin');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Sign-in failed');
    } finally {
      setLoading(false);
    }
  };

  return <PublicShell>
    <div className="max-w-md mx-auto bg-white/85 border border-stone-300 p-7 space-y-5">
      <div><p className="text-xs tracking-[0.25em] uppercase text-muted">Virgo Boys Radio / Private</p>
        <h1 className="text-3xl font-bold mt-2">Station admin</h1>
        <p className="text-sm mt-2 text-muted">Password-protected broadcast health and DJ access controls.</p>
      </div>
      <form onSubmit={(e) => void signIn(e)} className="space-y-3">
        <label className="block text-sm font-semibold" htmlFor="admin-password">Password</label>
        <input id="admin-password" value={password} type="password" required
          autoComplete="current-password" onChange={(e) => setPassword(e.target.value)}
          className="w-full border border-stone-300 bg-white p-3 text-ink" />
        <button type="submit" disabled={loading || !password}
          className="w-full bg-ink text-paper py-3 font-bold uppercase tracking-wider disabled:opacity-50">
          {loading ? 'Checking…' : 'Open admin'}
        </button>
        {message && <p role="alert" className="text-sm text-red-700">{message}</p>}
      </form>
      <p className="text-xs text-muted">Sessions expire after eight hours. For a public radio service, use a stronger password than a short memorable word before inviting external guests.</p>
    </div>
  </PublicShell>;
}
