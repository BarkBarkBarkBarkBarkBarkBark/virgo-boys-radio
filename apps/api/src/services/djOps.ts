import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { getDb } from '../db/client.js';

type RecentSession = {
  id: string;
  label: string;
  startedAt: string;
  endedAt: string | null;
  durationSeconds: number | null;
  bytesReceived: number;
  reason: string;
  closeCode: number | null;
};

type LiveBroadcast = {
  id: string;
  label: string;
  startedAt: string;
  startedMs: number;
  bytesReceived: number;
  framesReceived: number;
  lastFrameMs: number;
  lastHeartbeatMs: number;
  encoderPid: number | null;
  encoderPendingBytes: number;
  rateKbps: number;
  rateWindowStart: number;
  rateWindowBytes: number;
};

let live: LiveBroadcast | null = null;
const TABLES = `
CREATE TABLE IF NOT EXISTS dj_invitations (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  token_sha256 TEXT NOT NULL UNIQUE,
  code_sha256 TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE TABLE IF NOT EXISTS dj_broadcast_sessions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  bytes_received INTEGER NOT NULL,
  reason TEXT NOT NULL,
  close_code INTEGER
);
`;
let initialized = false;

function ensureTables(): void {
  if (initialized) return;
  getDb().exec(TABLES);
  initialized = true;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function codeFromRandom(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const source = randomBytes(12);
  return Array.from(source, (value) => alphabet[value % alphabet.length]).join('');
}

export function createDjInvite(label: string, hours: number) {
  ensureTables();
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new Error('Invalid expiry.');
  const sanitizedLabel = label.trim().slice(0, 70) || 'Guest DJ';
  const token = randomBytes(32).toString('hex');
  const code = codeFromRandom();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + hours * 3_600_000).toISOString();
  const id = randomUUID();
  getDb().prepare(`INSERT INTO dj_invitations
    (id, label, token_sha256, code_sha256, created_at, expires_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, ?, NULL)`)
    .run(id, sanitizedLabel, digest(token), digest(code), createdAt, expiresAt);
  return { id, label: sanitizedLabel, token, code, createdAt, expiresAt };
}

export function listDjInvites() {
  ensureTables();
  return getDb().prepare(`SELECT id, label, created_at AS createdAt,
    expires_at AS expiresAt, revoked_at AS revokedAt
    FROM dj_invitations ORDER BY created_at DESC LIMIT 60`).all();
}

export function revokeDjInvite(id: string): boolean {
  ensureTables();
  if (!/^[a-f0-9-]{36}$/i.test(id)) return false;
  const result = getDb().prepare(`UPDATE dj_invitations SET revoked_at = ?
    WHERE id = ? AND revoked_at IS NULL`).run(new Date().toISOString(), id);
  return result.changes > 0;
}

export function verifyDjCredential(message: { token?: string | undefined; code?: string | undefined }):
  { id: string; label: string } | null {
  ensureTables();
  const token = message.token;
  const code = message.code?.toUpperCase().replace(/[\s-]/g, '');
  const isToken = typeof token === 'string' && /^[a-f0-9]{64}$/i.test(token);
  const isCode = typeof code === 'string' && /^[A-HJ-NP-Z2-9]{12}$/.test(code);
  if (!isToken && !isCode) return null;
  const hash = digest(isToken ? token!.toLowerCase() : code!);
  const field = isToken ? 'token_sha256' : 'code_sha256';
  const invite = getDb().prepare(`SELECT id, label, expires_at AS expiresAt, revoked_at AS revokedAt,
    ${field} AS storedHash FROM dj_invitations WHERE ${field} = ?`).get(hash) as
    { id: string; label: string; expiresAt: string; revokedAt: string | null; storedHash: string } | undefined;
  if (!invite || invite.revokedAt || invite.expiresAt <= new Date().toISOString()) return null;
  const a = Buffer.from(invite.storedHash, 'hex');
  const b = Buffer.from(hash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b) ? { id: invite.id, label: invite.label } : null;
}

export function startDjMetrics(label: string, pid: number | null) {
  if (live) throw new Error('Another DJ is already active');
  const time = Date.now();
  const session: LiveBroadcast = {
    id: randomUUID(), label, startedAt: new Date(time).toISOString(), startedMs: time,
    bytesReceived: 0, framesReceived: 0, lastFrameMs: time, lastHeartbeatMs: time,
    encoderPid: pid, encoderPendingBytes: 0, rateKbps: 0,
    rateWindowStart: time, rateWindowBytes: 0,
  };
  live = session;
  return session.id;
}

export function noteDjFrame(sessionId: string, bytes: number, pendingBytes: number) {
  if (live?.id !== sessionId) return;
  const now = Date.now();
  live.framesReceived += 1;
  live.bytesReceived += bytes;
  live.rateWindowBytes += bytes;
  live.lastFrameMs = now;
  live.encoderPendingBytes = pendingBytes;
  const elapsed = now - live.rateWindowStart;
  if (elapsed >= 1500) {
    live.rateKbps = Math.round(live.rateWindowBytes * 8 / elapsed);
    live.rateWindowBytes = 0;
    live.rateWindowStart = now;
  }
}

export function noteDjHeartbeat(sessionId: string) {
  if (live?.id === sessionId) live.lastHeartbeatMs = Date.now();
}

export function endDjMetrics(sessionId: string, reason: string, closeCode?: number) {
  if (!live || live.id !== sessionId) return;
  ensureTables();
  const session = live;
  live = null;
  const endedAt = new Date().toISOString();
  const durationSeconds = Math.max(0, Math.round((Date.now() - session.startedMs) / 1000));
  getDb().prepare(`INSERT INTO dj_broadcast_sessions
    (id, label, started_at, ended_at, duration_seconds, bytes_received, reason, close_code)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(session.id, session.label, session.startedAt, endedAt, durationSeconds,
      session.bytesReceived, reason.slice(0, 160), closeCode ?? null);
}

export function getDjMetrics() {
  ensureTables();
  const now = Date.now();
  const recent = getDb().prepare(`SELECT id, label, started_at AS startedAt,
    ended_at AS endedAt, duration_seconds AS durationSeconds,
    bytes_received AS bytesReceived, reason, close_code AS closeCode
    FROM dj_broadcast_sessions ORDER BY ended_at DESC LIMIT 25`).all() as RecentSession[];
  const mem = process.memoryUsage();
  return {
    generatedAt: new Date(now).toISOString(),
    live: live ? {
      id: live.id, label: live.label, startedAt: live.startedAt,
      uptimeSeconds: Math.round((now - live.startedMs) / 1000),
      bytesReceived: live.bytesReceived, framesReceived: live.framesReceived,
      inputKbps: live.rateKbps,
      lastAudioAgeMs: now - live.lastFrameMs,
      lastHeartbeatAgeMs: now - live.lastHeartbeatMs,
      ffmpegPid: live.encoderPid,
      encoderPendingBytes: live.encoderPendingBytes,
    } : null,
    recent,
    process: { uptimeSeconds: Math.round(process.uptime()), rssMB: Math.round(mem.rss / 1_048_576) },
  };
}
