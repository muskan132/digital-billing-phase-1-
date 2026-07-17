import { notFound } from 'next/navigation';
import { renderTemplate, LayoutBlock, BillSnapshot } from '../../src/render/template-renderer';
import { BillBlocks } from '../../src/render/BillBlocks';
import { DownloadButton } from '../../src/render/DownloadButton';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';

interface BillViewPayload {
  identifier: string;
  merchant: { name: string };
  bill: {
    template: { layoutSchema: LayoutBlock[] };
    snapshot: BillSnapshot;
  };
}

// Runtime shape check for L-2's response — this crosses an HTTP boundary, so
// TypeScript's compile-time types give no guarantee about what actually came back.
function isBillViewPayload(value: unknown): value is BillViewPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.identifier !== 'string') return false;
  if (typeof v.merchant !== 'object' || v.merchant === null) return false;
  if (typeof (v.merchant as Record<string, unknown>).name !== 'string') return false;
  if (typeof v.bill !== 'object' || v.bill === null) return false;
  const bill = v.bill as Record<string, unknown>;
  if (typeof bill.snapshot !== 'object' || bill.snapshot === null) return false;
  if (typeof bill.template !== 'object' || bill.template === null) return false;
  if (!Array.isArray((bill.template as Record<string, unknown>).layoutSchema)) return false;
  return true;
}

function ErrorState() {
  return (
    <div className="bill-error">
      <p>Something went wrong loading this bill. Please try again later.</p>
    </div>
  );
}

export default async function BillPage({ params }: { params: Promise<{ identifier: string }> }) {
  const { identifier } = await params;

  let response: Response;
  try {
    // Each identifier is unique bill content — never serve a cached response.
    response = await fetch(`${API_BASE_URL}/v1/links/${encodeURIComponent(identifier)}`, {
      cache: 'no-store',
    });
  } catch {
    // Network error reaching the API — not the customer's fault, don't leak details.
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

  if (!isBillViewPayload(payload)) {
    return <ErrorState />;
  }

  let blocks;
  try {
    blocks = renderTemplate(payload.bill.template.layoutSchema, payload.bill.snapshot);
  } catch {
    // D-10: renderTemplate throws on an unknown block type — a template data bug,
    // not something to expose to a public unauthenticated page.
    return <ErrorState />;
  }

  return (
    <>
      <BillBlocks blocks={blocks} />
      <DownloadButton />
    </>
  );
}
