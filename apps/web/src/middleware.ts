import { NextResponse, type NextRequest } from 'next/server';
import { ADMIN_COOKIE, verifyAdminSession } from './lib/adminSession';

export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === '/admin/login') return NextResponse.next();
  if (!await verifyAdminSession(request.cookies.get(ADMIN_COOKIE)?.value)) {
    const destination = request.nextUrl.clone();
    destination.pathname = '/admin/login';
    destination.search = '';
    return NextResponse.redirect(destination, 307);
  }
  const response = NextResponse.next();
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}

export const config = {
  matcher: ['/admin/:path*'],
};
