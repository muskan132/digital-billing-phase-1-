// W-3: the Phase-3 builder mounted at /portal/templates/:id. Same
// components as apps/web/app/(main)/demo/templates/[id]/page.tsx
// (useBuilderState/EditBillPanel/FinalLookTab — imported unchanged, zero
// edits to src/builder/*), different data-loading shell: the demo page
// fetches client-side (safe there — DemoOnlyGuard is env-based, not
// session-based); here the initial load happens server-side (RSC, cookie
// forwarded, same pattern as every other portal page) and is handed to the
// client builder as a prop — a plain client-side fetch can't reliably
// carry the session cookie cross-origin (apps/api's CORS has no
// `credentials: true`), which is also why the write actions are Route
// Handler proxies (./[id]/save|clone|set-default|archive/route.ts) rather
// than direct browser calls.
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { LayoutSchemaV2 } from '@digital-billing/block-manifest';
import { BuilderClient } from './BuilderClient';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
const SESSION_COOKIE = 'session';

export interface PortalTemplateRow {
  id: string;
  name: string;
  layoutSchema: LayoutSchemaV2;
}

// Crosses an HTTP boundary — same reasoning as every other portal page's
// runtime shape check (H-2/H-3/W-2).
function isPortalTemplateRow(value: unknown): value is PortalTemplateRow {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string' && typeof v.layoutSchema === 'object' && v.layoutSchema !== null;
}

function ErrorState() {
  return (
    <div className="portal-builder-load-error">
      <p>Something went wrong loading this template. Please try again later.</p>
    </div>
  );
}

export default async function PortalTemplateBuilderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/portal/templates/${encodeURIComponent(id)}`, {
      cache: 'no-store',
      headers: sessionCookie ? { cookie: `${SESSION_COOKIE}=${sessionCookie.value}` } : {},
    });
  } catch {
    return <ErrorState />;
  }

  if (response.status === 404) {
    notFound();
  }

  if (!response.ok) {
    return <ErrorState />;
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return <ErrorState />;
  }

  if (!isPortalTemplateRow(payload)) {
    return <ErrorState />;
  }

  return <BuilderClient template={payload} />;
}
