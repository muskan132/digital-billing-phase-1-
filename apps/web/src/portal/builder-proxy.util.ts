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

// The server-to-server call: forward the session cookie by hand, fetch a CSRF
// token, call the real API, pass the response straight back.
async function proxyPortal(method: 'POST' | 'DELETE', apiPath: string, body?: unknown): Promise<NextResponse> {
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

  const apiResponse = await fetch(`${API_BASE_URL}${apiPath}`, {
    method,
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

export async function proxyPortalTemplateWrite(
  templateId: string,
  action: 'save' | 'save-as' | 'set-default' | 'archive',
  body?: unknown,
): Promise<NextResponse> {
  return proxyPortal('POST', `/portal/templates/${encodeURIComponent(templateId)}/${action}`, body);
}

// F-3 (D-66): create-from-scratch — `POST /portal/templates`, no template id.
export async function proxyPortalTemplateCreate(body: unknown): Promise<NextResponse> {
  return proxyPortal('POST', '/portal/templates', body);
}

// F-4 (D-64): hard-delete — `DELETE /portal/templates/:id`. The browser POSTs
// to the Next route (which can't sit beside [id]/page.tsx as a bare route.ts,
// hence the /delete segment); the Next route issues the real DELETE.
export async function proxyPortalTemplateDelete(templateId: string): Promise<NextResponse> {
  return proxyPortal('DELETE', `/portal/templates/${encodeURIComponent(templateId)}`);
}
