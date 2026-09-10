import { proxyPortalTemplateWrite } from '../../../../../src/portal/builder-proxy.util';

// F-5 (D-65) / F-8: restore an archived template — `POST
// /portal/templates/:id/restore`. Same server-to-server proxy shape as
// archive/route.ts. The restore button itself is F-8 (the archived view).
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyPortalTemplateWrite(id, 'restore');
}
