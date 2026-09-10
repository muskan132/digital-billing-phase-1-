import { NextRequest } from 'next/server';
import { proxyPortalTemplateCreate } from '../../../src/portal/builder-proxy.util';

// F-3 (D-66): create-from-scratch. `POST /portal/templates { name, billType,
// skeleton }` → server-to-server proxy (session cookie + CSRF), same shape as
// the [id]/save-as handler. The create button itself is F-8; this keeps the
// endpoint reachable from the browser.
export async function POST(request: NextRequest) {
  const body = (await request.json()) as unknown;
  return proxyPortalTemplateCreate(body);
}
