import { NextRequest } from 'next/server';
import { proxyPortalTemplateWrite } from '../../../../../src/portal/builder-proxy.util';

// F-2 (D-62): Save As — same server-to-server proxy shape as save/route.ts
// (needs the session cookie + CSRF token). Replaces the old clone/route.ts.
// The Save As button itself is F-8; this keeps the endpoint reachable.
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json()) as unknown;
  return proxyPortalTemplateWrite(id, 'save-as', body);
}
