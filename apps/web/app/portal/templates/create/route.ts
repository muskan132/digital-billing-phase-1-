import { NextRequest } from 'next/server';
import { proxyPortalTemplateCreate } from '../../../../src/portal/builder-proxy.util';

// F-3 (D-66) / F-8: create-from-scratch. `POST /portal/templates/create` (the
// browser can't POST to `/portal/templates` itself now that a page.tsx list
// lives there) → server-to-server proxy (session cookie + CSRF) → the real
// `POST /portal/templates { name, billType, skeleton }`.
export async function POST(request: NextRequest) {
  const body = (await request.json()) as unknown;
  return proxyPortalTemplateCreate(body);
}
