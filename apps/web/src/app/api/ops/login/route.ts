import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_COOKIE, SESSION_SECONDS, createAdminSession } from '@/lib/adminSession';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (!origin || new URL(origin).origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: 'Invalid request origin' }, { status: 403 });
  }
  let password: string;
  try {
    const payload = await request.json() as { password?: unknown };
    if (typeof payload.password !== 'string' || payload.password.length > 150) throw new Error('Invalid password');
    password = payload.password;
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const base = process.env.OPS_API_BASE_URL ?? process.env.NEXT_PUBLIC_API_BASE_URL;
  if (!base) return NextResponse.json({ error: 'Admin authentication unavailable' }, { status: 503 });
  try {
    const result = await fetch(base.replace(/\/$/, '') + '/ops/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
      signal: AbortSignal.timeout(7000),
      cache: 'no-store',
    });
    if (!result.ok) {
      return NextResponse.json({ error: result.status === 429 ? 'Too many attempts. Try again in five minutes.' : 'Incorrect password' },
        { status: result.status === 429 ? 429 : 401, headers: { 'Cache-Control': 'no-store' } });
    }
    const token = await createAdminSession();
    const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
    response.cookies.set({
      name: ADMIN_COOKIE, value: token, httpOnly: true, secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict', path: '/', maxAge: SESSION_SECONDS,
    });
    return response;
  } catch {
    return NextResponse.json({ error: 'Admin API unreachable. Check the Fly deployment.' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
