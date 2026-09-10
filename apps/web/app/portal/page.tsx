// W-2: the authenticated dashboard — template list, create-invoice entry
// point, recent bills. No new business logic: templates come from
// TemplatesService.list() (reused as-is, via the new read-only
// GET /portal/templates wiring), bills come from H-1's
// PortalBillsService.list() (via the existing GET /portal/bills, capped
// small, no filters — a summary panel, not H-2's history view). Same
// server-to-server fetch pattern as H-2/W-1.
import { cookies } from 'next/headers';
import { formatMoney } from '../../src/render/money-format';
import { formatUtcTimestamp } from '../../src/render/date-format';
import { DefaultTemplatesModule } from './DefaultTemplatesModule';

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
const SESSION_COOKIE = 'session';
const RECENT_BILLS_LIMIT = 5;

interface PortalTemplateListItem {
  id: string;
  name: string;
  billType: string;
  skeleton: string;
  version: number;
  isDefault: boolean;
}

interface PortalTemplateListResponse {
  templates: PortalTemplateListItem[];
  defaultTemplateId: string | null;
}

// F-6 (D-76): GET /portal/templates/defaults — the two default pointers
// resolved to { id, name } for the "Default templates" module.
interface PortalTemplateDefaultsResponse {
  receipt: { id: string; name: string } | null;
  taxInvoice: { id: string; name: string } | null;
}

interface PortalMe {
  merchantName: string;
  role: string;
}

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

// Crosses an HTTP boundary — same reasoning as the other portal pages'
// runtime shape checks (H-2/H-3): TypeScript's compile-time types give no
// guarantee about what actually came back.
function isPortalTemplateListResponse(value: unknown): value is PortalTemplateListResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.templates)) return false;
  if (v.defaultTemplateId !== null && typeof v.defaultTemplateId !== 'string') return false;
  return v.templates.every((t) => {
    if (typeof t !== 'object' || t === null) return false;
    const item = t as Record<string, unknown>;
    return (
      typeof item.id === 'string' &&
      typeof item.name === 'string' &&
      typeof item.billType === 'string' &&
      typeof item.skeleton === 'string' &&
      typeof item.version === 'number' &&
      typeof item.isDefault === 'boolean'
    );
  });
}

function isPortalBillListResponse(value: unknown): value is PortalBillListResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.items);
}

function isDefaultRef(value: unknown): value is { id: string; name: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.id === 'string' && typeof v.name === 'string';
}

function isPortalTemplateDefaultsResponse(value: unknown): value is PortalTemplateDefaultsResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (v.receipt === null || isDefaultRef(v.receipt)) && (v.taxInvoice === null || isDefaultRef(v.taxInvoice));
}

function isPortalMe(value: unknown): value is PortalMe {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.merchantName === 'string' && typeof v.role === 'string';
}

const BILL_TYPE_LABELS: Record<string, string> = {
  RECEIPT: 'Receipt',
  TAX_INVOICE: 'Tax invoice',
};

async function fetchJson<T>(path: string, sessionCookieValue: string | undefined): Promise<T | null> {
  try {
    const response = await fetch(`${API_BASE_URL}${path}`, {
      cache: 'no-store',
      headers: sessionCookieValue ? { cookie: `${SESSION_COOKIE}=${sessionCookieValue}` } : {},
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export default async function PortalDashboard() {
  const cookieStore = await cookies();
  const sessionCookie = cookieStore.get(SESSION_COOKIE)?.value;

  const [templatesRaw, billsRaw, defaultsRaw, meRaw] = await Promise.all([
    fetchJson<unknown>('/portal/templates', sessionCookie),
    fetchJson<unknown>(`/portal/bills?limit=${RECENT_BILLS_LIMIT}`, sessionCookie),
    fetchJson<unknown>('/portal/templates/defaults', sessionCookie),
    fetchJson<unknown>('/portal/me', sessionCookie),
  ]);

  const templates = isPortalTemplateListResponse(templatesRaw) ? templatesRaw : null;
  const bills = isPortalBillListResponse(billsRaw) ? billsRaw : null;
  const defaults = isPortalTemplateDefaultsResponse(defaultsRaw) ? defaultsRaw : null;
  const me = isPortalMe(meRaw) ? meRaw : null;
  const canEditDefaults = me?.role === 'MERCHANT_ADMIN';

  const createInvoiceHref = templates?.defaultTemplateId
    ? `/portal/templates/${templates.defaultTemplateId}`
    : '#dashboard-templates';

  return (
    <section className="portal-dashboard">
      <div className="portal-dashboard-header">
        <h1 className="portal-dashboard-title">Dashboard</h1>
        <a href={createInvoiceHref} className="portal-dashboard-create-invoice">
          Create invoice
        </a>
      </div>

      <section id="dashboard-templates" className="portal-dashboard-panel">
        <h2 className="portal-dashboard-panel-title">Templates</h2>
        {templates === null ? (
          <p className="portal-dashboard-error">Something went wrong loading your templates.</p>
        ) : templates.templates.length === 0 ? (
          <p className="portal-dashboard-empty">No templates yet.</p>
        ) : (
          <ul className="portal-dashboard-template-list">
            {templates.templates.map((template) => (
              <li key={template.id}>
                <a href={`/portal/templates/${template.id}`} className="portal-dashboard-template-link">
                  {template.name}
                  {template.isDefault ? <span className="portal-dashboard-badge">Default</span> : null}
                </a>
                <span className="portal-dashboard-template-meta">
                  {BILL_TYPE_LABELS[template.billType] ?? template.billType} · v{template.version}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {defaults === null ? (
        <section className="portal-dashboard-panel">
          <h2 className="portal-dashboard-panel-title">Default templates</h2>
          <p className="portal-dashboard-error">Something went wrong loading your default templates.</p>
        </section>
      ) : (
        <DefaultTemplatesModule
          defaults={defaults}
          candidates={(templates?.templates ?? []).map((t) => ({ id: t.id, name: t.name, billType: t.billType }))}
          canEdit={canEditDefaults}
        />
      )}

      <section className="portal-dashboard-panel">
        <div className="portal-dashboard-panel-header">
          <h2 className="portal-dashboard-panel-title">Recent bills</h2>
          <a href="/portal/bills" className="portal-dashboard-view-all">
            View all →
          </a>
        </div>
        {bills === null ? (
          <p className="portal-dashboard-error">Something went wrong loading your recent bills.</p>
        ) : bills.items.length === 0 ? (
          <p className="portal-dashboard-empty">No bills yet.</p>
        ) : (
          <table className="portal-dashboard-bills-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Type</th>
                <th>Invoice #</th>
                <th>Amount</th>
              </tr>
            </thead>
            <tbody>
              {bills.items.map((bill) => (
                <tr key={bill.id}>
                  <td>
                    <a href={`/portal/bills/${bill.id}`}>{formatUtcTimestamp(bill.createdAt) ?? bill.createdAt}</a>
                  </td>
                  <td>{BILL_TYPE_LABELS[bill.billType] ?? bill.billType}</td>
                  <td>{bill.invoiceNumber ?? '—'}</td>
                  <td>{formatMoney(bill.totalPaise, bill.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </section>
  );
}
