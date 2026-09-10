import { proxyPortalTemplateDelete } from '../../../../../src/portal/builder-proxy.util';

// F-4 (D-64): hard-delete. The browser POSTs here (a bare [id]/route.ts can't
// coexist with [id]/page.tsx); this handler issues the real
// DELETE /portal/templates/:id. The delete button itself is F-8.
export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyPortalTemplateDelete(id);
}
