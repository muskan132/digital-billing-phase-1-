import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

// W-3: shared body for the four builder write-action Route Handlers
// (save/save-as/set-default/archive) — same server-to-server pattern
// app/portal/logout/route.ts established (W-1): the browser calls this
// Next route, which fetches the CSRF token and calls the real API itself,
// forwarding the session cookie by hand since a server-side fetch doesn't
// inherit it. The browser never calls /portal/templates/*'s mutating
// routes directly (apps/api/src/main.ts restricts direct browser calls to
// the demo panel).
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
const SESSION_COOKIE = 'session';

export async function proxyPortalTemplateWrite(
  templateId: string,
  action: 'save' | 'save-as' | 'set-default' | 'archive',
  body?: unknown,
): Promise<NextResponse> {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE);
  if (!sessionCookie) {
    return NextResponse.json({ error_code: 'NO_SESSION' }, { status: 401 });
  }

  const csrfResponse = await fetch(`${API_BASE_URL}/portal/csrf-token`, {
    headers: { cookie: `${SESSION_COOKIE}=${sessionCookie.value}` },
    cache: 'no-store',
  });
  if (!csrfResponse.ok) {
    return NextResponse.json({ error_code: 'CSRF_TOKEN_FETCH_FAILED' }, { status: 502 });
  }
  const { token } = (await csrfResponse.json()) as { token: string };

  const apiResponse = await fetch(`${API_BASE_URL}/portal/templates/${encodeURIComponent(templateId)}/${action}`, {
    method: 'POST',
    headers: {
      cookie: `${SESSION_COOKIE}=${sessionCookie.value}`,
      'x-csrf-token': token,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

  const responseBody = await apiResponse.text();
  return new NextResponse(responseBody, {
    status: apiResponse.status,
    headers: { 'content-type': apiResponse.headers.get('content-type') ?? 'application/json' },
  });
}
