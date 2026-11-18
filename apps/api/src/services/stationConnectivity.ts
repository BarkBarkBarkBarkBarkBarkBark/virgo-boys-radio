import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { getDb } from '../db/client.js';

const TYPES = new Set(['play_requested', 'playing', 'waiting', 'stalled', 'error', 'ended', 'pause', 'reconnect_scheduled', 'reconnecting', 'play_rejected', 'heartbeat', 'broadcast_connected', 'broadcast_disconnected', 'broadcast_congestion', 'broadcast_health', 'verification']);
const PHASES = new Set(['idle', 'connecting', 'playing', 'buffering', 'error', 'paused', 'stopped', 'checking', 'verified', 'warning', 'unavailable']);
type Role = 'listener' | 'broadcaster' | 'monitor';
export type ConnectivityInput = {
  clientId: string; role: Role; event: string; phase?: string | undefined; details?: string | undefined;
  bufferedSeconds?: number | undefined; networkState?: number | undefined; readyState?: number | undefined;
  queueBytes?: number | undefined; droppedFrames?: number | undefined;
  delayMs?: number | undefined; matchPercent?: number | undefined;
};
let lastPrune = 0;
function ensureTable() {
  getDb().exec('CREATE TABLE IF NOT EXISTS station_connectivity_events (' +
    'id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, role TEXT NOT NULL, ' +
    'client_id TEXT NOT NULL, ip TEXT NOT NULL, event TEXT NOT NULL, phase TEXT NOT NULL, ' +
    'details TEXT NOT NULL, buffered_seconds REAL, network_state INTEGER, ready_state INTEGER, ' +
    'queue_bytes INTEGER, dropped_frames INTEGER, delay_ms INTEGER, match_percent INTEGER);' +
    'CREATE INDEX IF NOT EXISTS station_connectivity_recent ON station_connectivity_events(created_at DESC);' +
    'CREATE INDEX IF NOT EXISTS station_connectivity_client ON station_connectivity_events(client_id, id DESC);');
}
function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max) : '';
}
function bounded(value: unknown, max: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}
export function cleanIp(value: unknown): string {
  if (typeof value !== 'string') return 'unknown';
  const candidate = value.split(',')[0]?.trim() ?? '';
  return /^[a-f0-9:.]{3,48}$/i.test(candidate) ? candidate : 'unknown';
}
export function recordConnectivity(input: ConnectivityInput, observedIp: string) {
  if (!['listener', 'broadcaster', 'monitor'].includes(input.role) || !TYPES.has(input.event)) return false;
  const clientId = cleanText(input.clientId, 75);
  if (!/^[a-zA-Z0-9_-]{8,75}$/.test(clientId)) return false;
  ensureTable();
  const now = Date.now();
  getDb().prepare('INSERT INTO station_connectivity_events ' +
    '(created_at, role, client_id, ip, event, phase, details, buffered_seconds, network_state, ready_state, queue_bytes, dropped_frames, delay_ms, match_percent) ' +
    'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
      new Date(now).toISOString(), input.role, clientId, cleanIp(observedIp), input.event,
      PHASES.has(input.phase ?? '') ? input.phase : 'idle', cleanText(input.details, 180),
      bounded(input.bufferedSeconds, 600), bounded(input.networkState, 10),
      bounded(input.readyState, 10), bounded(input.queueBytes, 16 * 1024 * 1024),
      bounded(input.droppedFrames, 1e9), bounded(input.delayMs, 120_000), bounded(input.matchPercent, 100));
  if (now - lastPrune > 3_600_000) {
    lastPrune = now;
    getDb().prepare("DELETE FROM station_connectivity_events WHERE datetime(created_at) < datetime('now', '-7 days')").run();
    getDb().prepare('DELETE FROM station_connectivity_events WHERE id IN ' +
      '(SELECT id FROM station_connectivity_events ORDER BY id DESC LIMIT -1 OFFSET 18000)').run();
  }
  return true;
}
export function getConnectivityEvents(limit = 250, clientId = '') {
  ensureTable();
  const n = Math.min(500, Math.max(1, Math.floor(limit)));
  const base = 'SELECT id, created_at AS createdAt, role, client_id AS clientId, ip, event, phase, details, ' +
    'buffered_seconds AS bufferedSeconds, network_state AS networkState, ready_state AS readyState, ' +
    'queue_bytes AS queueBytes, dropped_frames AS droppedFrames, delay_ms AS delayMs, match_percent AS matchPercent ' +
    'FROM station_connectivity_events';
  return clientId
    ? getDb().prepare(base + ' WHERE client_id = ? ORDER BY id DESC LIMIT ?').all(clientId, n)
    : getDb().prepare(base + ' ORDER BY id DESC LIMIT ?').all(n);
}
export function getConnectivityClients() {
  ensureTable();
  return getDb().prepare(
    'SELECT last.client_id AS clientId, last.role, last.ip, first.first_seen AS firstSeen, ' +
    'last.created_at AS lastSeen, last.phase, last.event, last.details, ' +
    'last.buffered_seconds AS bufferedSeconds, last.queue_bytes AS queueBytes, ' +
    'last.dropped_frames AS droppedFrames, last.delay_ms AS delayMs, last.match_percent AS matchPercent, ' +
    "CASE WHEN datetime(last.created_at) > datetime('now', '-45 seconds') " +
    "AND last.phase NOT IN ('paused', 'stopped', 'error') THEN 1 ELSE 0 END AS recentlyActive " +
    'FROM station_connectivity_events last ' +
    'INNER JOIN (SELECT client_id, MAX(id) AS id FROM station_connectivity_events ' +
    "WHERE datetime(created_at) > datetime('now', '-24 hours') GROUP BY client_id) latest ON latest.id = last.id " +
    'INNER JOIN (SELECT client_id, MIN(created_at) AS first_seen FROM station_connectivity_events ' +
    "WHERE datetime(created_at) > datetime('now', '-24 hours') GROUP BY client_id) first ON first.client_id = last.client_id " +
    'ORDER BY last.id DESC LIMIT 80').all();
}
function tail(path: string, maxBytes: number): string {
  const size = statSync(path).size;
  const fd = openSync(path, 'r');
  try {
    const count = Math.min(size, maxBytes);
    const buf = Buffer.alloc(count);
    const actual = readSync(fd, buf, 0, count, size - count);
    const data = buf.toString('utf8', 0, actual);
    return size > count ? data.slice(data.indexOf('\n') + 1) : data;
  } finally { closeSync(fd); }
}
export function getStreamAccessHistory() {
  try {
    const rows = tail('/data/radio-access.jsonl', 384 * 1024).split('\n').filter(Boolean);
    return rows.slice(-130).reverse().flatMap((line) => {
      try {
        const value = JSON.parse(line) as {
          ts?: number; status?: number; size?: number; duration?: number;
          request?: { remote_ip?: string; client_ip?: string; uri?: string; headers?: Record<string, string[]> };
        };
        if (!value.request?.uri?.startsWith('/radio.mp3')) return [];
        const header = value.request.headers ?? {};
        return [{
          at: typeof value.ts === 'number' ? new Date(value.ts * 1000).toISOString() : '',
          ip: cleanIp(header['Fly-Client-Ip']?.[0] ?? value.request.client_ip ?? value.request.remote_ip),
          status: value.status ?? null, bytes: value.size ?? null,
          durationSeconds: typeof value.duration === 'number' ? Math.round(value.duration * 10) / 10 : null,
          userAgent: cleanText(header['User-Agent']?.[0] ?? '', 120),
        }];
      } catch { return []; }
    });
  } catch { return []; }
}
export async function getIcecastClientSnapshot() {
  const password = process.env.ICECAST_ADMIN_PASSWORD;
  if (!password) return { available: false, clients: [], note: 'Icecast admin credentials are not configured.' };
  try {
    const auth = Buffer.from('admin:' + password).toString('base64');
    const response = await fetch('http://127.0.0.1:8000/admin/listclients?mount=%2Fradio.mp3', {
      headers: { Authorization: 'Basic ' + auth }, signal: AbortSignal.timeout(1800),
    });
    if (!response.ok) return { available: false, clients: [], note: 'Icecast client listing returned HTTP ' + response.status };
    const xml = await response.text();
    const tag = (body: string, name: string) => {
      const m = body.match(new RegExp('<' + name + '>([\\s\\S]*?)</' + name + '>', 'i'));
      return m ? (m[1] ?? '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
    };
    const clients = [...xml.matchAll(/<client>([\s\S]*?)<\/client>/gi)].slice(0, 120).map((m) => ({
      icecastId: cleanText(tag(m[1] ?? '', 'ID'), 40),
      ip: cleanIp(tag(m[1] ?? '', 'IP')),
      connectedSeconds: bounded(Number(tag(m[1] ?? '', 'Connected')), 86400 * 7),
      userAgent: cleanText(tag(m[1] ?? '', 'UserAgent'), 120),
    }));
    return { available: true, clients, note: 'Icecast may show the internal proxy IP. Browser sessions and completed Caddy access logs provide additional attribution.' };
  } catch {
    return { available: false, clients: [], note: 'Icecast client listing unavailable.' };
  }
}
