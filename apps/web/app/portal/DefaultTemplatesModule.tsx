'use client';

// F-6 (D-76): the dashboard "Default templates" module — shows the merchant's
// current receipt and tax-invoice defaults and, for MERCHANT_ADMIN, lets them
// change each one. The change action POSTs to the existing set-default proxy
// (app/portal/templates/[id]/set-default/route.ts), which carries the session
// cookie + CSRF token; same pattern as BuilderClient's Save.
//
// STORE_STAFF (canEdit=false) sees the current defaults read-only — the
// set-default API route is MERCHANT_ADMIN only, so no picker is rendered for
// them (F-6 MINOR-4).
import { useState } from 'react';

export interface DefaultRef {
  id: string;
  name: string;
}

export interface DefaultTemplatesModuleProps {
  defaults: { receipt: DefaultRef | null; taxInvoice: DefaultRef | null };
  candidates: { id: string; name: string; billType: string }[];
  canEdit: boolean;
}

type RowState = { status: 'idle' } | { status: 'saving' } | { status: 'error'; message: string };

const BILL_TYPE_LABELS: Record<string, string> = {
  RECEIPT: 'Receipt',
  TAX_INVOICE: 'Tax invoice',
};

function DefaultTemplateRow({
  billType,
  current,
  candidates,
  canEdit,
}: {
  billType: 'RECEIPT' | 'TAX_INVOICE';
  current: DefaultRef | null;
  candidates: { id: string; name: string }[];
  canEdit: boolean;
}) {
  const [selected, setSelected] = useState<string>(current?.id ?? candidates[0]?.id ?? '');
  const [state, setState] = useState<RowState>({ status: 'idle' });

  async function handleSetDefault() {
    if (!selected || selected === current?.id) return;
    setState({ status: 'saving' });
    try {
      const response = await fetch(`/portal/templates/${encodeURIComponent(selected)}/set-default`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      });
      const data = (await response.json().catch(() => null)) as { message?: string; error_code?: string } | null;
      if (!response.ok) {
        setState({
          status: 'error',
          message: data?.message ?? data?.error_code ?? 'Could not set the default.',
        });
        return;
      }
      window.location.reload();
    } catch {
      setState({ status: 'error', message: 'Could not reach the server.' });
    }
  }

  return (
    <div className="portal-dashboard-default-row">
      <div className="portal-dashboard-default-row-label">{BILL_TYPE_LABELS[billType]}</div>
      <div className="portal-dashboard-default-row-value">
        {current ? current.name : <span className="portal-dashboard-default-none">None set</span>}
      </div>
      {canEdit && candidates.length > 0 && (
        <div className="portal-dashboard-default-row-picker">
          <select
            aria-label={`Default ${BILL_TYPE_LABELS[billType]} template`}
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={state.status === 'saving'}
          >
            {candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleSetDefault}
            disabled={state.status === 'saving' || !selected || selected === current?.id}
          >
            {state.status === 'saving' ? 'Saving…' : 'Set as default'}
          </button>
        </div>
      )}
      {state.status === 'error' && <p className="portal-dashboard-error">{state.message}</p>}
    </div>
  );
}

export function DefaultTemplatesModule({ defaults, candidates, canEdit }: DefaultTemplatesModuleProps) {
  const receiptCandidates = candidates.filter((c) => c.billType === 'RECEIPT');
  const taxInvoiceCandidates = candidates.filter((c) => c.billType === 'TAX_INVOICE');

  return (
    <section className="portal-dashboard-panel">
      <h2 className="portal-dashboard-panel-title">Default templates</h2>
      <div className="portal-dashboard-default-list">
        <DefaultTemplateRow billType="RECEIPT" current={defaults.receipt} candidates={receiptCandidates} canEdit={canEdit} />
        <DefaultTemplateRow
          billType="TAX_INVOICE"
          current={defaults.taxInvoice}
          candidates={taxInvoiceCandidates}
          canEdit={canEdit}
        />
      </div>
    </section>
  );
}
