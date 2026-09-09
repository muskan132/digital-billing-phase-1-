import { NextRequest } from 'next/server';
import { proxyPortalTemplateWrite } from '../../../../../src/portal/builder-proxy.util';

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = (await request.json()) as unknown;
  return proxyPortalTemplateWrite(id, 'save', body);
}
