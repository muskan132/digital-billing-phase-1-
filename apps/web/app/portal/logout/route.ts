import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

// W-1: server-to-server only (apps/api/src/main.ts restricts direct browser
// calls to the demo panel) — the browser calls this Next route, which fetches
// the CSRF token and calls the API's /portal/logout itself, forwarding the
// session cookie by hand since a server-side fetch doesn't inherit it.
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
const SESSION_COOKIE = 'session';

export async function POST() {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE);

  if (sessionCookie) {
    const csrfResponse = await fetch(`${API_BASE_URL}/portal/csrf-token`, {
      headers: { cookie: `${SESSION_COOKIE}=${sessionCookie.value}` },
      cache: 'no-store',
    });
    if (csrfResponse.ok) {
      const { token } = (await csrfResponse.json()) as { token: string };
      await fetch(`${API_BASE_URL}/portal/logout`, {
        method: 'POST',
        headers: {
          cookie: `${SESSION_COOKIE}=${sessionCookie.value}`,
          'x-csrf-token': token,
        },
      });
    }
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.delete(SESSION_COOKIE);
  return response;
}
