// H-3 (frontend): the bill detail page — consumes GET /portal/bills/:id
// as-is (full contact, line items, broadcast list, public-page link via
// identifier). Server Component, server-to-server fetch with the session
// cookie forwarded, same pattern as H-2's list page and W-1's layout.
import { cookies } from 'next/headers';
import { notFound } from 'next/navigation';
import { formatMoney } from '../../../../src/render/money-format';
import { formatUtcTimestamp } from '../../../../src/render/date-format';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
const PUBLIC_BILL_BASE_URL = process.env.PUBLIC_BILL_BASE_URL ?? 'http://localhost:3000';
const SESSION_COOKIE = 'session';

interface PortalBillDetailLineItem {
  lineNo: number;
  name: string;
  hsn: string;
  uom: string;
  quantity: number;
  unitPricePaise: string;
  itemDiscountPaise: string;
  billDiscountAllocPaise: string;
  taxRateBp: number;
  taxableValuePaise: string;
  taxPaise: string;
  cgstPaise: string;
  sgstPaise: string;
  igstPaise: string;
}

interface PortalBillBroadcast {
  channel: string;
  status: string;
  attempts: number;
  sentAt: string | null;
  recipientMasked: string | null;
}

interface PortalBillDetail {
  id: string;
  createdAt: string;
  billType: string;
  source: string;
  invoiceNumber: string | null;
  totalPaise: string;
  currency: string;
  subtotalPaise: string | null;
  discountPaise: string | null;
  taxPaise: string | null;
  cgstPaise: string | null;
  sgstPaise: string | null;
  igstPaise: string | null;
  placeOfSupply: string | null;
  merchantGstin: string | null;
  items: PortalBillDetailLineItem[];
  identifier: string | null;
  customerMobile: string | null;
  customerEmail: string | null;
  broadcasts: PortalBillBroadcast[];
}

// Crosses an HTTP boundary — TypeScript's compile-time types give no
// runtime guarantee about what actually came back (same reasoning as
// isBillViewPayload / isPortalBillListResponse elsewhere in this app).
function isPortalBillDetail(value: unknown): value is PortalBillDetail {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string') return false;
  if (typeof v.createdAt !== 'string') return false;
  if (typeof v.billType !== 'string') return false;
  if (typeof v.source !== 'string') return false;
  if (typeof v.totalPaise !== 'string') return false;
  if (typeof v.currency !== 'string') return false;
  if (!Array.isArray(v.items)) return false;
  if (!Array.isArray(v.broadcasts)) return false;
  if (v.identifier !== null && typeof v.identifier !== 'string') return false;
  if (v.customerMobile !== null && typeof v.customerMobile !== 'string') return false;
  if (v.customerEmail !== null && typeof v.customerEmail !== 'string') return false;
  return true;
}

const BILL_TYPE_LABELS: Record<string, string> = {
  RECEIPT: 'Receipt',
  TAX_INVOICE: 'Tax invoice',
};

const SOURCE_LABELS: Record<string, string> = {
  PG_CALLBACK: 'PG receipt',
  DIRECT_API: 'Direct API',
};

function ErrorState() {
  return (
    <div className="portal-bill-detail-error">
      <p>Something went wrong loading this bill. Please try again later.</p>
    </div>
  );
}

function money(paise: string | null, currency: string): string {
  return paise === null ? '—' : formatMoney(paise, currency);
}

export default async function PortalBillDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE);

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/portal/bills/${encodeURIComponent(id)}`, {
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

  if (!isPortalBillDetail(payload)) {
    return <ErrorState />;
  }

  return (
    <section className="portal-bill-detail">
      <a href="/portal/bills" className="portal-bill-detail-back">
        ← Back to bills
      </a>

      <h1 className="portal-bill-detail-title">
        {BILL_TYPE_LABELS[payload.billType] ?? payload.billType}
        {payload.invoiceNumber ? ` — ${payload.invoiceNumber}` : ''}
      </h1>

      <dl className="portal-bill-detail-facts">
        <div>
          <dt>Date</dt>
          <dd>{formatUtcTimestamp(payload.createdAt) ?? payload.createdAt}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{SOURCE_LABELS[payload.source] ?? payload.source}</dd>
        </div>
        <div>
          <dt>Total</dt>
          <dd>{money(payload.totalPaise, payload.currency)}</dd>
        </div>
        <div>
          <dt>Subtotal</dt>
          <dd>{money(payload.subtotalPaise, payload.currency)}</dd>
        </div>
        <div>
          <dt>Discount</dt>
          <dd>{money(payload.discountPaise, payload.currency)}</dd>
        </div>
        <div>
          <dt>Tax</dt>
          <dd>{money(payload.taxPaise, payload.currency)}</dd>
        </div>
        <div>
          <dt>CGST</dt>
          <dd>{money(payload.cgstPaise, payload.currency)}</dd>
        </div>
        <div>
          <dt>SGST</dt>
          <dd>{money(payload.sgstPaise, payload.currency)}</dd>
        </div>
        <div>
          <dt>IGST</dt>
          <dd>{money(payload.igstPaise, payload.currency)}</dd>
        </div>
        <div>
          <dt>Place of supply</dt>
          <dd>{payload.placeOfSupply ?? '—'}</dd>
        </div>
        <div>
          <dt>Merchant GSTIN</dt>
          <dd>{payload.merchantGstin ?? '—'}</dd>
        </div>
      </dl>

      <h2 className="portal-bill-detail-subheading">Customer contact</h2>
      <dl className="portal-bill-detail-facts">
        <div>
          <dt>Mobile</dt>
          <dd>{payload.customerMobile ?? '—'}</dd>
        </div>
        <div>
          <dt>Email</dt>
          <dd>{payload.customerEmail ?? '—'}</dd>
        </div>
      </dl>

      <h2 className="portal-bill-detail-subheading">Line items</h2>
      {payload.items.length === 0 ? (
        <p className="portal-bill-detail-empty">No line items for this bill.</p>
      ) : (
        <table className="portal-bill-detail-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>HSN</th>
              <th>UOM</th>
              <th>Qty</th>
              <th>Unit price</th>
              <th>Tax</th>
            </tr>
          </thead>
          <tbody>
            {payload.items.map((item) => (
              <tr key={item.lineNo}>
                <td>{item.lineNo}</td>
                <td>{item.name}</td>
                <td>{item.hsn}</td>
                <td>{item.uom}</td>
                <td>{item.quantity}</td>
                <td>{money(item.unitPricePaise, payload.currency)}</td>
                <td>{money(item.taxPaise, payload.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2 className="portal-bill-detail-subheading">Broadcasts</h2>
      {payload.broadcasts.length === 0 ? (
        <p className="portal-bill-detail-empty">No broadcasts for this bill.</p>
      ) : (
        <table className="portal-bill-detail-table">
          <thead>
            <tr>
              <th>Channel</th>
              <th>Status</th>
              <th>Attempts</th>
              <th>Sent at</th>
              <th>Recipient</th>
            </tr>
          </thead>
          <tbody>
            {payload.broadcasts.map((broadcast, index) => (
              <tr key={index}>
                <td>{broadcast.channel}</td>
                <td>{broadcast.status}</td>
                <td>{broadcast.attempts}</td>
                <td>{broadcast.sentAt ? (formatUtcTimestamp(broadcast.sentAt) ?? broadcast.sentAt) : '—'}</td>
                <td>{broadcast.recipientMasked ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {payload.identifier && (
        <a
          href={`${PUBLIC_BILL_BASE_URL}/${payload.identifier}`}
          className="portal-bill-detail-public-link"
          target="_blank"
          rel="noreferrer"
        >
          View public bill page →
        </a>
      )}
    </section>
  );
}
