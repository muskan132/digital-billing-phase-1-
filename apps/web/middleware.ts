import { NextRequest, NextResponse } from 'next/server';

// W-1: the single gate for every /portal/* page. Redirects to /auth/login
// with returnTo set to the path that was actually requested, so a successful
// login lands back where the user was headed instead of always /portal root.
// /portal/logout is excluded — it's a POST from an already-authenticated
// page and handles a dead session itself; redirecting a POST here would
// otherwise bounce it at the API's GET-only /auth/login.
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
const SESSION_COOKIE = 'session';

export const config = {
  matcher: '/portal/:path*',
};

export async function middleware(request: NextRequest) {
  if (request.nextUrl.pathname === '/portal/logout') {
    return NextResponse.next();
  }

  const sessionCookie = request.cookies.get(SESSION_COOKIE);
  const returnTo = `${request.nextUrl.pathname}${request.nextUrl.search}`;

  if (!sessionCookie) {
    return redirectToLogin(returnTo);
  }

  let meResponse: Response;
  try {
    meResponse = await fetch(`${API_BASE_URL}/portal/me`, {
      headers: { cookie: `${SESSION_COOKIE}=${sessionCookie.value}` },
      cache: 'no-store',
    });
  } catch {
    return redirectToLogin(returnTo);
  }

  if (!meResponse.ok) {
    return redirectToLogin(returnTo);
  }

  return NextResponse.next();
}

function redirectToLogin(returnTo: string): NextResponse {
  const loginUrl = new URL('/auth/login', API_BASE_URL);
  loginUrl.searchParams.set('returnTo', returnTo);
  return NextResponse.redirect(loginUrl);
}
