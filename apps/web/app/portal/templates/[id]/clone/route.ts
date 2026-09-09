import { proxyPortalTemplateWrite } from '../../../../../src/portal/builder-proxy.util';

export async function POST(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxyPortalTemplateWrite(id, 'clone');
}
