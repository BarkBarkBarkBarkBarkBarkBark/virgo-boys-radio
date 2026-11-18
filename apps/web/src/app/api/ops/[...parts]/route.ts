import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_COOKIE, verifyAdminSession } from '@/lib/adminSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ parts?: string[] }> };

async function proxy(request: NextRequest, context: Context, method: 'GET' | 'POST') {
  if (!await verifyAdminSession(request.cookies.get(ADMIN_COOKIE)?.value)) {
    return NextResponse.json({ error: 'Admin session expired' }, { status: 401 });
  }
  if (method === 'POST') {
    const origin = request.headers.get('origin');
    if (!origin || new URL(origin).origin !== request.nextUrl.origin) {
      return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
    }
  }
  const parts = (await context.params).parts ?? [];
  const path = parts.join('/');
  const suffix = path === 'connectivity' ? request.nextUrl.search : '';
  const permitted =
    (method === 'GET' && (path === 'metrics' || path === 'invites' || path === 'connectivity')) ||
    (method === 'POST' && path === 'invites') ||
    (method === 'POST' && /^invites\/[a-f0-9-]{36}\/revoke$/i.test(path));
  if (!permitted) return NextResponse.json({ error: 'Unknown operation' }, { status: 404 });

  const key = process.env.OPS_SHARED_SECRET;
  const base = process.env.OPS_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!key || !base) return NextResponse.json({ error: 'Server authentication is not configured' }, { status: 503 });

  try {
    let body: string | undefined;
    if (method === 'POST') {
      body = await request.text();
      if (body.length > 2048) return NextResponse.json({ error: 'Request too large' }, { status: 413 });
    }
    const upstream = await fetch(base.replace(/\/$/, '') + '/ops/' + path + suffix, {
      method,
      headers: { 'x-station-ops-key': key, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(6000),
    });
    const response = await upstream.text();
    return new NextResponse(response, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
    });
  } catch {
    return NextResponse.json({ error: 'Fly metrics API is unreachable' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}

export async function GET(request: NextRequest, context: Context) {
  return proxy(request, context, 'GET');
}
export async function POST(request: NextRequest, context: Context) {
  return proxy(request, context, 'POST');
}
