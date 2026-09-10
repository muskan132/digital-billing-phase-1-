import { NextRequest, NextResponse } from 'next/server';
import { cookies } from 'next/headers';

// E-2 (D-71): the browser cannot hit apps/api's /portal/bills/export.csv
// directly — the session cookie is httpOnly and set for the web origin, not
// :4000. This GET proxy forwards it and streams the CSV (with its
// content-type + content-disposition) straight back. GET, so no CSRF token.
// A 403 (STORE_STAFF) or 422 (bad/missing contact) from the API passes through
// as-is so the caller sees the real status and body.
const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
const SESSION_COOKIE = 'session';

export async function GET(request: NextRequest) {
  const session = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!session) {
    return NextResponse.json({ error_code: 'NO_SESSION' }, { status: 401 });
  }

  const qs = request.nextUrl.searchParams.toString();
  const apiRes = await fetch(`${API_BASE_URL}/portal/bills/export.csv${qs ? `?${qs}` : ''}`, {
    headers: { cookie: `${SESSION_COOKIE}=${session}` },
    cache: 'no-store',
  });

  const body = await apiRes.text();
  const headers = new Headers();
  const contentType = apiRes.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  const disposition = apiRes.headers.get('content-disposition');
  if (disposition) headers.set('content-disposition', disposition);

  return new NextResponse(body, { status: apiRes.status, headers });
}
