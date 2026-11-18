'use client';

import { useCallback, useEffect, useState } from 'react';
import { ConnectivityLab } from '@/components/ConnectivityLab';
import { AudioSelfTestPanel } from '@/components/AudioSelfTestPanel';

type Live = {
  id: string; label: string; startedAt: string; uptimeSeconds: number; bytesReceived: number;
  inputFormat?: 'webm_opus' | 'pcm_s16le';
  framesReceived: number; inputKbps: number; lastAudioAgeMs: number;
  lastHeartbeatAgeMs: number; ffmpegPid: number | null; encoderPendingBytes: number;
  browserBufferedBytes: number; browserDroppedFrames: number;
};
type Drop = {
  id: string; label: string; startedAt: string; endedAt: string;
  durationSeconds: number; bytesReceived: number; reason: string; closeCode: number | null;
};
type Snapshot = {
  generatedAt: string;
  live: Live | null;
  recent: Drop[];
  process: { uptimeSeconds: number; rssMB: number };
  icecast: { reachable: boolean; sourceConnected: boolean; listeners: number; bitrateKbps: number | null; audioInfo?: string | null };
};
type Invite = { id: string; label: string; createdAt: string; expiresAt: string; revokedAt: string | null };
type IssuedInvite = Invite & { token: string; code: string };

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch('/api/ops/' + path, { ...init, cache: 'no-store' });
  const data = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(data.error ?? 'Request failed (' + response.status + ')');
  return data;
}
const formatTime = (seconds: number) => {
  const s = Math.max(0, seconds);
  return Math.floor(s / 60) + 'm ' + (s % 60).toString().padStart(2, '0') + 's';
};
const formatDate = (iso: string) => new Date(iso).toLocaleString();

export function OperationsDashboard() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState('');
  const [lastRefresh, setLastRefresh] = useState('');
  const [label, setLabel] = useState('Guest DJ');
  const [hours, setHours] = useState('24');
  const [issued, setIssued] = useState<IssuedInvite | null>(null);
  const [generating, setGenerating] = useState(false);
  const [copyMessage, setCopyMessage] = useState('');

  const refresh = useCallback(async () => {
    try {
      const result = await requestJson<Snapshot>('metrics');
      setSnapshot(result);
      setLastRefresh(new Date().toLocaleTimeString());
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Metrics unavailable');
    }
  }, []);
  const refreshInvites = useCallback(async () => {
    try {
      const data = await requestJson<{ invites: Invite[] }>('invites');
      setInvites(data.invites);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Invite lookup failed'); }
  }, []);

  useEffect(() => {
    void refresh();
    void refreshInvites();
    const interval = window.setInterval(() => void refresh(), 4000);
    return () => window.clearInterval(interval);
  }, [refresh, refreshInvites]);

  const createInvite = async () => {
    setGenerating(true);
    setError('');
    try {
      const response = await requestJson<{ invite: IssuedInvite }>('invites', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || 'Guest DJ', hours: Number(hours) }),
      });
      setIssued(response.invite);
      setCopyMessage('');
      await refreshInvites();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Failed to generate invite'); }
    finally { setGenerating(false); }
  };

  const revoke = async (invite: Invite) => {
    if (!confirm('Revoke access for ' + invite.label + '? An already-running broadcast is not interrupted.')) return;
    try {
      await requestJson('invites/' + invite.id + '/revoke', { method: 'POST' });
      if (issued?.id === invite.id) setIssued(null);
      await refreshInvites();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not revoke link'); }
  };

  const copy = async (value: string, label: string) => {
    try { await navigator.clipboard.writeText(value); setCopyMessage(label + ' copied.'); }
    catch { setCopyMessage('Browser blocked copying. Select the text manually.'); }
  };
  const signOut = async () => {
    await fetch('/api/ops/logout', { method: 'POST' }).catch(() => undefined);
    window.location.href = '/admin/login';
  };
  const link = issued ? 'https://virgoboys.com/stream#token=' + issued.token : '';
  const live = snapshot?.live ?? null;
  const icecast = snapshot?.icecast;

  return (
    <div className="space-y-7">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.25em] text-muted">Station operations · private</p>
          <h1 className="text-3xl font-bold">Broadcast monitor</h1>
          <p className="text-xs text-muted mt-1">Updated every 4 seconds {lastRefresh ? '· Last check ' + lastRefresh : ''}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" onClick={() => void refresh()} className="border border-ink px-4 py-2 text-xs uppercase">Refresh</button>
          <button type="button" onClick={() => void signOut()} className="border border-ink px-4 py-2 text-xs uppercase">Sign out</button>
        </div>
      </div>
      {error && <div role="alert" className="border border-red-300 bg-red-50 text-red-800 p-4 text-sm">{error}. If Fly was not redeployed after the admin update, run the latest Fly deploy.</div>}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'DJ uplink', value: live ? 'CONNECTED' : 'OFF AIR', detail: live ? live.label + ' · ' + formatTime(live.uptimeSeconds) : 'No active browser DJ' },
          { label: 'Icecast origin', value: icecast?.sourceConnected ? 'ON AIR' : icecast?.reachable ? 'NO SOURCE' : 'UNAVAILABLE', detail: icecast?.sourceConnected ? 'Broadcast mount connected' : 'Listener mount not active' },
          { label: 'Listeners', value: String(icecast?.listeners ?? '—'), detail: 'Icecast source listeners (not WebRTC)' },
          { label: 'Output bitrate', value: icecast?.bitrateKbps ? icecast.bitrateKbps + ' kbps' : '—', detail: 'Reported by Icecast when available' },
        ].map(({ label: heading, value, detail }) => (
          <div key={heading} className="border border-stone-300 bg-white/85 p-5 space-y-2">
            <p className="text-xs uppercase tracking-wider text-muted">{heading}</p>
            <p className="text-2xl font-bold text-ink">{value}</p>
            <p className="text-xs text-muted">{detail}</p>
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="border border-stone-300 bg-white/85 p-5 space-y-3">
          <h2 className="text-lg font-bold">Connection stability</h2>
          <dl className="grid grid-cols-2 gap-3 text-sm">
            {[
              ['Uplink throughput', live ? live.inputKbps + ' kbps' : '—'],
              ['Uplink codec', live ? live.inputFormat === 'webm_opus' ? 'WebM/Opus · 192 kbps requested' : 'PCM · 48 kHz stereo' : '—'],
              ['Expected upload', live ? live.inputFormat === 'webm_opus' ? '≈192 kbps compressed' : '≈1,536 kbps PCM' : '—'],
              ['Last audio packet', live ? live.lastAudioAgeMs + ' ms ago' : '—'],
              ['Last browser heartbeat', live ? live.lastHeartbeatAgeMs + ' ms ago' : '—'],
              ['FFmpeg encoder PID', live?.ffmpegPid?.toString() ?? '—'],
              ['FFmpeg input queue', live ? Math.round(live.encoderPendingBytes / 1024) + ' KiB' : '—'],
              ['Browser upload backlog', live ? Math.round(live.browserBufferedBytes / 1024) + ' KiB' : '—'],
              ['Skipped late audio frames', live ? live.browserDroppedFrames.toString() : '—'],
              ['Fly API process memory', snapshot?.process ? snapshot.process.rssMB + ' MB' : '—'],
              ['API process uptime', snapshot?.process ? formatTime(snapshot.process.uptimeSeconds) : '—'],
            ].map(([heading, value]) => (
              <div key={heading}><dt className="text-xs text-muted">{heading}</dt><dd className="font-semibold">{value}</dd></div>
            ))}
          </dl>
          <p className="text-xs text-muted">If the browser backlog increases, its uplink is congested; it temporarily skips late audio rather than instantly ending the set. A 4008 close identifies sustained upload congestion. Opus uses ~192 kbps compressed audio with ordered WebM chunks; PCM uses ~1,536 kbps. A 1000 close means the tab or operator intentionally stopped. A 1005 close has no status code and is ambiguous.</p>
        </div>

        <div className="border border-stone-300 bg-white/85 p-5 space-y-3">
          <h2 className="text-lg font-bold">Recent disconnects</h2>
          {snapshot?.recent.length ? (
            <div className="max-h-72 overflow-auto">
              {snapshot.recent.slice(0, 12).map((entry) => (
                <div key={entry.id} className="py-2 border-b border-stone-200 text-sm">
                  <div className="flex justify-between gap-3"><strong>{entry.label}</strong><span className="text-xs text-muted">{formatDate(entry.endedAt)}</span></div>
                  <p className="text-xs text-muted mt-1">{formatTime(entry.durationSeconds)} · {(entry.bytesReceived / 1_048_576).toFixed(1)} MB received</p>
                  <p className="text-xs break-words font-mono mt-1">{entry.reason}{entry.closeCode ? ' · code ' + entry.closeCode : ''}</p>
                </div>
              ))}
            </div>
          ) : <p className="text-sm text-muted">No completed sessions recorded yet. These records persist in the Fly SQLite database after deployment.</p>}
        </div>
      </div>

      <ConnectivityLab />
      <AudioSelfTestPanel />

      <div className="border border-stone-300 bg-white/85 p-5 space-y-5">
        <div><h2 className="text-xl font-bold">DJ invitations</h2>
          <p className="text-sm text-muted mt-1">Give a DJ a private magic link or a manually typed 12-character access code. Both expire automatically.</p></div>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-muted flex-1 min-w-44">DJ name
            <input type="text" maxLength={70} value={label} onChange={(e) => setLabel(e.target.value)}
              className="block mt-2 border border-stone-300 bg-white w-full p-3 text-sm text-ink" />
          </label>
          <label className="text-xs text-muted">Expires in
            <select className="block mt-2 border border-stone-300 bg-white p-3 text-sm text-ink"
              value={hours} onChange={(e) => setHours(e.target.value)}>
              <option value="2">2 hours</option><option value="24">24 hours</option><option value="168">7 days</option>
            </select>
          </label>
          <button type="button" disabled={generating} onClick={() => void createInvite()}
            className="px-5 py-3 bg-ink text-white uppercase font-bold tracking-wider text-xs disabled:opacity-50">
            {generating ? 'Generating…' : 'Create access'}
          </button>
        </div>

        {issued && <div className="bg-stone-100 border border-stone-300 p-4 space-y-3">
          <p className="font-bold">Access created for {issued.label}</p>
          <p className="text-xs text-muted">Share these privately. This is the only time the full magic link and passcode are shown here.</p>
          <div className="space-y-2"><p className="text-xs uppercase tracking-widest">Magic link</p>
            <p className="text-xs font-mono break-all">{link}</p>
            <button type="button" onClick={() => void copy(link, 'Magic link')} className="border border-ink px-4 py-2 text-xs font-bold">Copy link</button>
          </div>
          <div className="space-y-2"><p className="text-xs uppercase tracking-widest">Manual passcode</p>
            <p className="font-mono text-xl font-bold tracking-widest">{issued.code}</p>
            <button type="button" onClick={() => void copy(issued.code, 'Passcode')} className="border border-ink px-4 py-2 text-xs font-bold">Copy passcode</button>
          </div>
          {copyMessage && <p className="text-xs text-muted">{copyMessage}</p>}
          <p className="text-xs text-muted">Expires: {formatDate(issued.expiresAt)}</p>
        </div>}

        <div className="space-y-2">
          <h3 className="text-sm font-bold">Issued access</h3>
          {invites.length === 0 && <p className="text-sm text-muted">No invites yet.</p>}
          {invites.map((invite) => {
            const active = !invite.revokedAt && new Date(invite.expiresAt).getTime() > Date.now();
            return <div key={invite.id} className="flex flex-wrap justify-between items-center gap-2 border-t border-stone-200 py-3">
              <div><p className="text-sm font-semibold">{invite.label} <span className="text-xs text-muted">· {active ? 'Active' : invite.revokedAt ? 'Revoked' : 'Expired'}</span></p>
                <p className="text-xs text-muted">Expires {formatDate(invite.expiresAt)}</p></div>
              {active && <button type="button" onClick={() => void revoke(invite)} className="border border-red-600 text-red-700 px-3 py-2 text-xs font-bold">Revoke</button>}
            </div>;
          })}
        </div>
      </div>

      <p className="text-xs text-muted">Dashboard metrics reflect the Fly browser-uplink process and Icecast origin, not the legacy WebRTC room. Listener values are only as accurate as Icecast's current mount statistics. The initial monitor records completed sessions and refreshes every four seconds; it does not independently verify audio quality.</p>
      <a href="/admin/legacy" className="inline-block text-sm underline">Legacy station management (songs, events, artists)</a>
    </div>
  );
}
