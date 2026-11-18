import { NextResponse, type NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Public browser playback diagnostics, not an admin API. Never accept caller-
// supplied IP addresses or access credentials. The Fly endpoint requires the
// existing server-to-server OPS_SHARED_SECRET and stores only bounded metadata.
const EVENTS = new Set([
  'play_requested', 'playing', 'waiting', 'stalled', 'error', 'ended',
  'pause', 'reconnect_scheduled', 'reconnecting', 'play_rejected', 'heartbeat', 'verification',
]);

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (origin && origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: 'Origin not allowed' }, { status: 403 });
  }
  const declaredSize = Number(request.headers.get('content-length') || 0);
  if (declaredSize > 1100) return NextResponse.json({ error: 'Event too large' }, { status: 413 });
  let event: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > 1100) throw new Error('Event too large');
    event = JSON.parse(raw) as Record<string, unknown>;
  } catch { return NextResponse.json({ error: 'Invalid event' }, { status: 400 }); }

  const clientId = event.clientId;
  const kind = event.event;
  if (typeof clientId !== 'string' || !/^[a-zA-Z0-9_-]{8,75}$/.test(clientId)
    || typeof kind !== 'string' || !EVENTS.has(kind)) {
    return NextResponse.json({ error: 'Invalid event fields' }, { status: 400 });
  }

  const key = process.env.OPS_SHARED_SECRET;
  const base = process.env.OPS_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!key || !base) return NextResponse.json({ error: 'Telemetry unavailable' }, { status: 503 });

  // Vercel's forwarding header is recorded as *observed IP*; it may be a NAT,
  // proxy, or mobile egress address and cannot identify a person.
  const forwarded = request.headers.get('x-vercel-forwarded-for')
    ?? request.headers.get('x-forwarded-for') ?? '';
  const ip = forwarded.split(',')[0]?.trim() ?? '';
  const observedIp = /^[a-f0-9:.]{3,48}$/i.test(ip) ? ip : 'unknown';
  const allowNumbers = ['bufferedSeconds', 'networkState', 'readyState', 'queueBytes', 'droppedFrames', 'delayMs', 'matchPercent'];
  const payload: Record<string, unknown> = {
    clientId, role: event.role === 'monitor' ? 'monitor' : 'listener', event: kind,
    phase: typeof event.phase === 'string' ? event.phase.slice(0, 20) : 'idle',
    details: typeof event.details === 'string' ? event.details.slice(0, 180) : '',
    observedIp,
  };
  for (const field of allowNumbers) {
    if (typeof event[field] === 'number' && Number.isFinite(event[field])) payload[field] = event[field];
  }
  try {
    const upstream = await fetch(base.replace(/\/$/, '') + '/ops/telemetry', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-station-ops-key': key },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(3500), cache: 'no-store',
    });
    if (!upstream.ok) {
      console.warn('[radio-telemetry] Fly rejected client status:', upstream.status, kind);
      return NextResponse.json({ error: 'Telemetry storage unavailable' }, { status: 503 });
    }
    return new NextResponse(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    console.warn('[radio-telemetry] Fly connection unavailable for', kind);
    return NextResponse.json({ error: 'Telemetry storage unavailable' }, { status: 503 });
  }
}
