'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type Client = {
  clientId: string; role: string; ip: string; firstSeen: string; lastSeen: string;
  phase: string; event: string; details: string;
  bufferedSeconds: number | null; queueBytes: number | null;
  droppedFrames: number | null; delayMs: number | null;
  matchPercent: number | null; recentlyActive: number;
};
type Event = {
  id: number; createdAt: string; clientId: string; ip: string; role: string;
  event: string; phase: string; details: string;
  bufferedSeconds: number | null; queueBytes: number | null;
  droppedFrames: number | null; delayMs: number | null;
  matchPercent: number | null; networkState: number | null; readyState: number | null;
};
type StreamRequest = {
  at: string; ip: string; status: number | null; bytes: number | null;
  durationSeconds: number | null; userAgent: string;
};
type Response = {
  generatedAt: string; clients: Client[]; events: Event[];
  streamRequests: StreamRequest[];
  icecastClients: { available: boolean; note: string; clients: {
    icecastId: string; ip: string; connectedSeconds: number | null; userAgent: string;
  }[] };
  limitations: string;
};

const readable = (date: string) => date ? new Date(date).toLocaleString() : '—';
const bytes = (size: number | null) => size === null ? '—' : size >= 1048576
  ? (size / 1048576).toFixed(2) + ' MB' : (size / 1024).toFixed(0) + ' KiB';
function EventLine({ item }: { item: Event }) {
  return (
    <div className="py-2.5 border-b border-stone-200 text-xs">
      <div className="flex flex-wrap justify-between gap-2">
        <span className="font-mono font-bold">{item.event} · {item.phase}</span>
        <span className="text-muted">{readable(item.createdAt)}</span>
      </div>
      <p className="mt-1 font-mono text-muted break-all">{item.ip} · {item.clientId}</p>
      {item.details && <p className="mt-1 break-words">{item.details}</p>}
      <div className="flex flex-wrap gap-x-4 mt-1 text-muted">
        {item.bufferedSeconds !== null && <span>Audio buffered {item.bufferedSeconds.toFixed(1)}s</span>}
        {item.queueBytes !== null && <span>WS queue {bytes(item.queueBytes)}</span>}
        {item.droppedFrames !== null && <span>Dropped frames {item.droppedFrames}</span>}
        {item.delayMs !== null && <span>Listener delay {(item.delayMs / 1000).toFixed(1)}s</span>}
        {item.matchPercent !== null && <span>Music match {item.matchPercent}%</span>}
        {item.readyState !== null && <span>Media readyState {item.readyState}</span>}
        {item.networkState !== null && <span>Media networkState {item.networkState}</span>}
      </div>
    </div>
  );
}

export function ConnectivityLab() {
  const [expanded, setExpanded] = useState(false);
  const [snapshot, setSnapshot] = useState<Response | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/ops/connectivity?limit=400', { cache: 'no-store' });
      const json = await response.json() as Response & { error?: string };
      if (!response.ok) throw new Error(json.error || 'Diagnostics unavailable');
      setSnapshot(json);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Diagnostics unavailable');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    if (!expanded) return;
    setLoading(true);
    void load();
    const timer = window.setInterval(() => void load(), 8000);
    return () => window.clearInterval(timer);
  }, [expanded, load]);

  const q = query.trim().toLowerCase();
  const clients = useMemo(() => (snapshot?.clients ?? [])
    .filter((c) => !q || [c.ip, c.clientId, c.role, c.event].some((v) => v.toLowerCase().includes(q)))
    .sort((a, b) => b.recentlyActive - a.recentlyActive), [snapshot, q]);
  const events = useMemo(() => (snapshot?.events ?? []).filter((c) =>
    !q || [c.ip, c.clientId, c.role, c.event, c.phase, c.details].some((v) => v.toLowerCase().includes(q))),
  [snapshot, q]);
  const access = useMemo(() => (snapshot?.streamRequests ?? [])
    .filter((c) => !q || [c.ip, c.userAgent, String(c.status)].some((v) => v.toLowerCase().includes(q))), [snapshot, q]);

  return (
    <section className="border border-stone-400 bg-white/90">
      <button type="button" onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
        className="w-full flex flex-wrap items-center justify-between p-5 text-left hover:bg-stone-50">
        <span><strong className="block text-xl">Connection inspector</strong>
          <span className="block text-xs text-muted mt-1">Private · client IPs, listener interruptions, broadcast queue and detailed timelines</span>
        </span>
        <span className="text-sm font-mono">{expanded ? '− Close' : '+ Open diagnostics'}</span>
      </button>
      {expanded && (
        <div className="border-t border-stone-300 p-4 sm:p-6 space-y-6">
          <div className="flex flex-wrap gap-3 items-end justify-between">
            <label className="text-xs font-bold flex-1 min-w-48">Filter by IP, session or event
              <input value={query} onChange={(event) => setQuery(event.target.value)}
                placeholder="IP address, session ID, stalled…" type="search"
                className="mt-2 block w-full border border-stone-300 bg-white p-3 text-sm font-normal" />
            </label>
            <button type="button" onClick={() => { setLoading(true); void load(); }}
              disabled={loading} className="border border-ink px-4 py-3 text-xs font-bold disabled:opacity-50">
              {loading ? 'Refreshing…' : 'Refresh logs'}
            </button>
            <button type="button" disabled={!snapshot} onClick={() => {
              if (snapshot) void navigator.clipboard.writeText(JSON.stringify(snapshot, null, 2)).catch(() => undefined);
            }} className="border border-ink px-4 py-3 text-xs font-bold disabled:opacity-50">
              Copy snapshot JSON
            </button>
          </div>
          {error && <p role="alert" className="text-red-700 text-sm">{error}. This inspector requires the corresponding Fly backend deployment.</p>}
          {snapshot && (
            <>
              <div className="grid gap-2 sm:grid-cols-3">
                {[
                  ['Browser sessions', String(snapshot.clients.length), 'Seen in the last 24 hours'],
                  ['Recently active', String(snapshot.clients.filter((c) => !!c.recentlyActive).length), 'Telemetry received within 45 seconds'],
                  ['Icecast sockets', snapshot.icecastClients.available ? String(snapshot.icecastClients.clients.length) : '—', 'Reported by origin, if available'],
                ].map(([heading, value, note]) => <div key={heading} className="border border-stone-200 p-3">
                  <p className="text-[11px] text-muted uppercase">{heading}</p>
                  <p className="text-2xl font-bold">{value}</p><p className="text-xs text-muted">{note}</p>
                </div>)}
              </div>
              <p className="text-xs text-muted">Updated {readable(snapshot.generatedAt)}. IP addresses are network endpoints, not unique people; multiple clients may share an IP or switch networks.</p>

              <div className="space-y-3">
                <h3 className="text-lg font-bold">Browser connections · {clients.length}</h3>
                {!clients.length && <p className="text-sm text-muted">No matching telemetry yet. Open a listener in a browser and press Play to generate diagnostic events.</p>}
                <div className="space-y-2">
                  {clients.map((c) => {
                    const history = events.filter((item) => item.clientId === c.clientId);
                    return <details key={c.clientId} className="border border-stone-300 p-3">
                      <summary className="cursor-pointer">
                        <span className={'inline-block w-2 h-2 rounded-full mr-2 ' + (c.recentlyActive ? 'bg-green-600' : 'bg-stone-400')} />
                        <strong className="font-mono text-sm break-all">{c.ip}</strong>
                        <span className="ml-2 text-xs text-muted">{c.role} · {c.phase} · {c.event}</span>
                        <span className="block text-xs text-muted mt-1">{c.clientId.slice(0, 14)}… · Last reported {readable(c.lastSeen)}</span>
                      </summary>
                      <div className="pt-3 mt-3 border-t border-stone-200">
                        <div className="grid grid-cols-2 gap-2 text-xs mb-3">
                          <p>First seen: {readable(c.firstSeen)}</p>
                          <p>Last seen: {readable(c.lastSeen)}</p>
                          {c.queueBytes !== null && <p>Queue: {bytes(c.queueBytes)}</p>}
                          {c.droppedFrames !== null && <p>Frames dropped: {c.droppedFrames}</p>}
                          {c.delayMs !== null && <p>Delay: {(c.delayMs / 1000).toFixed(1)}s</p>}
                          {c.matchPercent !== null && <p>Match: {c.matchPercent}%</p>}
                        </div>
                        <h4 className="text-xs font-bold uppercase">Session events ({history.length} in recent window)</h4>
                        <div className="max-h-72 overflow-auto">{history.length ? history.map((e) => <EventLine key={e.id} item={e} />) :
                          <p className="text-xs text-muted py-2">No matching events in the current recent window.</p>}</div>
                      </div>
                    </details>;
                  })}
                </div>
              </div>

              <details className="border border-stone-300 p-4">
                <summary className="font-bold cursor-pointer">All verbose events · {events.length}</summary>
                <div className="mt-3 max-h-96 overflow-auto">
                  {events.map((e) => <EventLine key={e.id} item={e} />)}
                </div>
              </details>

              <details className="border border-stone-300 p-4">
                <summary className="font-bold cursor-pointer">HTTP stream connections · {access.length} completed</summary>
                <p className="text-xs text-muted mt-2">Caddy logs each public /radio.mp3 request on completion. Active streams will appear when their connection closes; raw clients may not send browser diagnostics.</p>
                <div className="mt-3 max-h-80 overflow-auto">
                  {access.map((req, i) => <div key={i} className="border-b border-stone-200 py-2 text-xs">
                    <strong className="font-mono">{req.ip}</strong> · HTTP {req.status ?? '—'} · {bytes(req.bytes)} · {req.durationSeconds ?? '—'}s
                    <p className="text-muted">{readable(req.at)}</p>
                    {req.userAgent && <p className="text-muted break-words">{req.userAgent}</p>}
                  </div>)}
                  {!access.length && <p className="text-xs text-muted mt-2">No completed stream requests yet. Logging begins after the Fly deployment.</p>}
                </div>
              </details>

              <details className="border border-stone-300 p-4">
                <summary className="font-bold cursor-pointer">Icecast active clients · {snapshot.icecastClients.clients.length}</summary>
                <p className="text-xs text-muted mt-2">{snapshot.icecastClients.note}</p>
                <div className="mt-3 max-h-72 overflow-auto">
                  {snapshot.icecastClients.clients.map((c, i) => <div key={c.icecastId + i} className="py-2 border-b text-xs">
                    <strong className="font-mono">{c.ip}</strong> · socket {c.icecastId} · {c.connectedSeconds ?? '—'}s connected
                    {c.userAgent && <p className="text-muted break-words">{c.userAgent}</p>}
                  </div>)}
                </div>
              </details>
              <p className="text-xs text-muted">Diagnostics persist in Fly SQLite for up to 7 days (capped at 18,000 events), and the origin access file rotates. No audio, passwords or invite tokens are stored. The separate Vercel Functions runtime logs are not ingested into this panel.</p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
