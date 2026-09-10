import { proxyPortalBillResend } from '../../../../../src/portal/builder-proxy.util';

// R-2 (D-69/D-79): resend a FAILED delivery. The browser POSTs here (a bare
// [id]/route.ts can't coexist with [id]/page.tsx, hence the /resend segment);
// this handler issues the real POST /portal/bills/:id/resend with the session
// cookie + CSRF token. No body is forwarded — the API route reads none.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyPortalBillResend(id);
}
