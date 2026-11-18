import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_COOKIE } from '@/lib/adminSession';

export async function POST(request: NextRequest) {
  const origin = request.headers.get('origin');
  if (!origin || new URL(origin).origin !== request.nextUrl.origin) {
    return NextResponse.json({ error: 'Invalid origin' }, { status: 403 });
  }
  const response = NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  response.cookies.set({ name: ADMIN_COOKIE, value: '', path: '/', maxAge: 0 });
  return response;
}
