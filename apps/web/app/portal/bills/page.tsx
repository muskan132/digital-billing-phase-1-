// H-2: the merchant's own bill history — GET /portal/bills (H-1), filters,
// keyset paging (forward via H-1's nextCursor, "back" via a client-side
// breadcrumb stack — see src/portal/bills-query.util.ts), empty state,
// money from BigInt paise only, timestamps in UTC. No detail page yet
// (H-3) — the link below points at the route regardless; it 404s today,
// exactly as expected until H-3 ships.
import { cookies } from 'next/headers';
import { formatMoney } from '../../../src/render/money-format';
import { formatUtcTimestamp } from '../../../src/render/date-format';
import {
  currentCursor,
  nextPageHref,
  parseCursorStack,
  parseFilters,
  previousPageHref,
  PortalBillsSearchParams,
} from '../../../src/portal/bills-query.util';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
const SESSION_COOKIE = 'session';

interface PortalBillListItem {
  id: string;
  createdAt: string;
  billType: string;
  source: string;
  invoiceNumber: string | null;
  totalPaise: string;
  currency: string;
  customerMobileMasked: string | null;
  customerEmailMasked: string | null;
}

interface PortalBillListResponse {
  items: PortalBillListItem[];
  nextCursor: string | null;
}

// Crosses an HTTP boundary — TypeScript's compile-time types give no
// runtime guarantee about what actually came back (same reasoning as
// isBillViewPayload in app/(main)/[identifier]/page.tsx).
function isPortalBillListResponse(value: unknown): value is PortalBillListResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.items)) return false;
  if (v.nextCursor !== null && typeof v.nextCursor !== 'string') return false;
  return v.items.every((item) => {
    if (typeof item !== 'object' || item === null) return false;
    const i = item as Record<string, unknown>;
    return (
      typeof i.id === 'string' &&
      typeof i.createdAt === 'string' &&
      typeof i.billType === 'string' &&
      typeof i.source === 'string' &&
      (i.invoiceNumber === null || typeof i.invoiceNumber === 'string') &&
      typeof i.totalPaise === 'string' &&
      typeof i.currency === 'string' &&
      (i.customerMobileMasked === null || typeof i.customerMobileMasked === 'string') &&
      (i.customerEmailMasked === null || typeof i.customerEmailMasked === 'string')
    );
  });
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
    <div className="portal-bills-error">
      <p>Something went wrong loading your bills. Please try again later.</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="portal-bills-empty">
      <p>No bills match these filters yet.</p>
    </div>
  );
}

export default async function PortalBillsPage({
  searchParams,
}: {
  searchParams: Promise<PortalBillsSearchParams>;
}) {
  const resolvedSearchParams = await searchParams;
  const filters = parseFilters(resolvedSearchParams);
  const cursorStack = parseCursorStack(resolvedSearchParams);
  const cursor = currentCursor(cursorStack);

  const query = new URLSearchParams();
  if (filters.dateFrom) query.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) query.set('dateTo', filters.dateTo);
  if (filters.billType) query.set('billType', filters.billType);
  if (filters.source) query.set('source', filters.source);
  if (cursor) query.set('cursor', cursor);

  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE);

  // E-2 (D-71): the CSV export is MERCHANT_ADMIN only — gate the button server-side.
  let role: string | undefined;
  try {
    const meRes = await fetch(`${API_BASE_URL}/portal/me`, {
      cache: 'no-store',
      headers: sessionCookie ? { cookie: `${SESSION_COOKIE}=${sessionCookie.value}` } : {},
    });
    if (meRes.ok) role = ((await meRes.json()) as { role?: string }).role;
  } catch {
    role = undefined;
  }
  const canExport = role === 'MERCHANT_ADMIN';
  const exportQuery = new URLSearchParams();
  if (filters.dateFrom) exportQuery.set('dateFrom', filters.dateFrom);
  if (filters.dateTo) exportQuery.set('dateTo', filters.dateTo);
  if (filters.billType) exportQuery.set('billType', filters.billType);
  if (filters.source) exportQuery.set('source', filters.source);
  const exportHref = (contact: 'masked' | 'full') => `/portal/bills/export?contact=${contact}&${exportQuery.toString()}`;

  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}/portal/bills?${query.toString()}`, {
      cache: 'no-store',
      headers: sessionCookie ? { cookie: `${SESSION_COOKIE}=${sessionCookie.value}` } : {},
    });
  } catch {
    return <ErrorState />;
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

  if (!isPortalBillListResponse(payload)) {
    return <ErrorState />;
  }

  return (
    <section className="portal-bills">
      <h1 className="portal-bills-title">Bills</h1>

      <form method="get" action="/portal/bills" className="portal-bills-filters">
        <label className="portal-bills-filter">
          From
          <input type="date" name="dateFrom" defaultValue={filters.dateFrom ?? ''} />
        </label>
        <label className="portal-bills-filter">
          To
          <input type="date" name="dateTo" defaultValue={filters.dateTo ?? ''} />
        </label>
        <label className="portal-bills-filter">
          Bill type
          <select name="billType" defaultValue={filters.billType ?? ''}>
            <option value="">All</option>
            <option value="RECEIPT">Receipt</option>
            <option value="TAX_INVOICE">Tax invoice</option>
          </select>
        </label>
        <label className="portal-bills-filter">
          Source
          <select name="source" defaultValue={filters.source ?? ''}>
            <option value="">All</option>
            <option value="PG_CALLBACK">PG receipt</option>
            <option value="DIRECT_API">Direct API</option>
          </select>
        </label>
        <button type="submit" className="portal-bills-filter-submit">
          Apply
        </button>
      </form>

      {canExport && (
        <div className="portal-bills-export">
          <span className="portal-bills-export-label">Export (respects the filters above):</span>
          <a href={exportHref('masked')} className="portal-bills-export-link">Download CSV — masked</a>
          <a href={exportHref('full')} className="portal-bills-export-link">Download CSV — full contact</a>
        </div>
      )}

      {payload.items.length === 0 ? (
        <EmptyState />
      ) : (
        <table className="portal-bills-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Type</th>
              <th>Source</th>
              <th>Invoice #</th>
              <th>Amount</th>
              <th>Mobile</th>
              <th>Email</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {payload.items.map((item) => (
              <tr key={item.id}>
                <td>{formatUtcTimestamp(item.createdAt) ?? item.createdAt}</td>
                <td>{BILL_TYPE_LABELS[item.billType] ?? item.billType}</td>
                <td>{SOURCE_LABELS[item.source] ?? item.source}</td>
                <td>{item.invoiceNumber ?? '—'}</td>
                <td>{formatMoney(item.totalPaise, item.currency)}</td>
                <td>{item.customerMobileMasked ?? '—'}</td>
                <td>{item.customerEmailMasked ?? '—'}</td>
                <td>
                  <a href={`/portal/bills/${item.id}`}>View</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="portal-bills-pagination">
        {cursorStack.length > 0 && (
          <a href={previousPageHref(filters, cursorStack)} className="portal-bills-page-link">
            Previous
          </a>
        )}
        {payload.nextCursor && (
          <a href={nextPageHref(filters, cursorStack, payload.nextCursor)} className="portal-bills-page-link">
            Next
          </a>
        )}
      </div>
    </section>
  );
}
