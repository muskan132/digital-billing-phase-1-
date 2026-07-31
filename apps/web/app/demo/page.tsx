'use client';

import { useState } from 'react';

// Demo control panel — NOT the merchant portal (that's separate future scope).
// Operator-only, no customer PII ever shown here, so the public-bill-page
// PII rules don't apply. Fixed dropdown choices only, no free text: nothing
// here can produce a live validation error mid-demo.
const API_ORIGIN = 'http://localhost:4000';

const CALLBACK_AMOUNTS = ['1.00', '10.00', '99.99', '250.00'];

const INVOICE_FIXTURES: { key: 'tax_invoice' | 'retail' | 'restaurant'; label: string }[] = [
  { key: 'tax_invoice', label: 'B2B Tax Invoice' },
  { key: 'retail', label: 'Retail' },
  { key: 'restaurant', label: 'Restaurant / QSR' },
];

const TAX_RATES = [
  { label: '5%', value: 500 },
  { label: '12%', value: 1200 },
  { label: '18%', value: 1800 },
  { label: '28%', value: 2800 },
];

const MAX_FORM_ITEMS = 3;

interface FormItem {
  name: string;
  quantity: string;
  unitPriceRupees: string;
  taxRateBp: number;
}

function emptyItem(): FormItem {
  return { name: '', quantity: '1', unitPriceRupees: '', taxRateBp: TAX_RATES[0].value };
}

type Result = { url: string } | { error: string } | null;

type PreviewResponse =
  | { ok: true; line_items: Record<string, unknown>[]; totals: Record<string, string>; tax_block: Record<string, string> }
  | { ok: false; error: string };

// Separate from postDemo below: preview-invoice's success shape is the computed
// totals/tax_block, not {url}, so it can't share postDemo's response parsing.
async function postPreview(items: unknown): Promise<PreviewResponse> {
  try {
    const response = await fetch(`${API_ORIGIN}/v1/demo/preview-invoice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    const data = await response.json();
    if (!response.ok) {
      return { ok: false, error: typeof data?.message === 'string' ? data.message : 'Preview failed.' };
    }
    return { ok: true, line_items: data.line_items, totals: data.totals, tax_block: data.tax_block };
  } catch {
    return { ok: false, error: 'Could not reach the API server.' };
  }
}

async function postDemo(path: string, body: unknown): Promise<Result> {
  try {
    const response = await fetch(`${API_ORIGIN}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      return { error: typeof data?.message === 'string' ? data.message : 'Request failed.' };
    }
    if (typeof data?.error === 'string') {
      return { error: data.error };
    }
    if (typeof data?.url === 'string') {
      return { url: data.url };
    }
    return { error: 'Unexpected response shape.' };
  } catch {
    return { error: 'Could not reach the API server.' };
  }
}

function ResultPanel({ result }: { result: Result }) {
  if (!result) return null;
  if ('error' in result) {
    return <p className="demo-error">{result.error}</p>;
  }
  return (
    <a className="demo-result-link" href={result.url} target="_blank" rel="noopener noreferrer">
      {result.url}
    </a>
  );
}

export default function DemoPage() {
  const [amount, setAmount] = useState(CALLBACK_AMOUNTS[0]);
  const [callbackBusy, setCallbackBusy] = useState(false);
  const [callbackResult, setCallbackResult] = useState<Result>(null);

  const [fixtureKey, setFixtureKey] = useState<(typeof INVOICE_FIXTURES)[number]['key']>(INVOICE_FIXTURES[0].key);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [invoiceResult, setInvoiceResult] = useState<Result>(null);

  const [formTemplateKey, setFormTemplateKey] = useState<(typeof INVOICE_FIXTURES)[number]['key']>(INVOICE_FIXTURES[0].key);
  const [formItems, setFormItems] = useState<FormItem[]>([emptyItem()]);
  const [formBusy, setFormBusy] = useState(false);
  const [formResult, setFormResult] = useState<Result>(null);

  async function sendPayment() {
    setCallbackBusy(true);
    setCallbackResult(null);
    setCallbackResult(await postDemo('/v1/demo/simulate-callback', { amount }));
    setCallbackBusy(false);
  }

  async function createInvoice() {
    setInvoiceBusy(true);
    setInvoiceResult(null);
    setInvoiceResult(await postDemo('/v1/demo/create-invoice', { fixtureKey }));
    setInvoiceBusy(false);
  }

  function updateFormItem(index: number, patch: Partial<FormItem>) {
    setFormItems((items) => items.map((item, i) => (i === index ? { ...item, ...patch } : item)));
  }

  function addFormItem() {
    setFormItems((items) => (items.length >= MAX_FORM_ITEMS ? items : [...items, emptyItem()]));
  }

  function removeFormItem(index: number) {
    setFormItems((items) => items.filter((_, i) => i !== index));
  }

  // Two-call chain, driven entirely by the server's own computed output —
  // the browser never calculates a total and never sends one to /v1/bills.
  // Step 1 (preview-invoice) is the only place raw form numbers are sent
  // anywhere; step 2 posts back exactly what step 1 returned, unmodified.
  async function createInvoiceFromForm() {
    // Guard before the network call: a blank/zero/negative price or quantity would
    // otherwise reach preview-invoice and come back as a 400 — a live error, exactly
    // what this form exists to prevent. Caught here instead, same as the fixed
    // dropdowns already prevent it for tax rate.
    for (const item of formItems) {
      const price = Number(item.unitPriceRupees);
      const qty = Number(item.quantity);
      if (!Number.isFinite(price) || price <= 0 || !Number.isInteger(qty) || qty < 1) {
        setFormResult({ error: 'Every item needs a quantity of at least 1 and a unit price greater than ₹0.' });
        return;
      }
    }

    setFormBusy(true);
    setFormResult(null);

    const preview = await postPreview(
      formItems.map((item) => ({
        name: item.name || 'Item',
        quantity: Number(item.quantity),
        // M-1's rupeesToPaise requires exactly 2 decimals — normalize whatever the
        // number input produced ("150", "150.5", "150.00") to that shape.
        unitPriceRupees: Number(item.unitPriceRupees).toFixed(2),
        taxRateBp: item.taxRateBp,
      })),
    );
    if (!preview.ok) {
      setFormResult({ error: preview.error });
      setFormBusy(false);
      return;
    }

    setFormResult(
      await postDemo('/v1/demo/create-invoice-from-computed', {
        templateKey: formTemplateKey,
        line_items: preview.line_items,
        totals: preview.totals,
        tax_block: preview.tax_block,
      }),
    );
    setFormBusy(false);
  }

  return (
    <div className="demo-panel">
      <h1>Demo Control Panel</h1>
      <p className="demo-subtitle">Internal use only — triggers real backend paths with fixed, pre-validated data.</p>

      <section className="demo-section">
        <h2>Simulate Payment (PG Callback)</h2>
        <select value={amount} onChange={(e) => setAmount(e.target.value)} disabled={callbackBusy}>
          {CALLBACK_AMOUNTS.map((a) => (
            <option key={a} value={a}>
              ₹{a}
            </option>
          ))}
        </select>
        <button onClick={sendPayment} disabled={callbackBusy}>
          {callbackBusy ? 'Sending…' : 'Send Payment'}
        </button>
        <ResultPanel result={callbackResult} />
      </section>

      <section className="demo-section">
        <h2>Create Invoice — Fixed Fixture (fallback)</h2>
        <select
          value={fixtureKey}
          onChange={(e) => setFixtureKey(e.target.value as typeof fixtureKey)}
          disabled={invoiceBusy}
        >
          {INVOICE_FIXTURES.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>
        <button onClick={createInvoice} disabled={invoiceBusy}>
          {invoiceBusy ? 'Creating…' : 'Create Invoice'}
        </button>
        <ResultPanel result={invoiceResult} />
      </section>

      <section className="demo-section">
        <h2>Create Invoice — Live Form</h2>
        <select
          value={formTemplateKey}
          onChange={(e) => setFormTemplateKey(e.target.value as typeof formTemplateKey)}
          disabled={formBusy}
        >
          {INVOICE_FIXTURES.map((f) => (
            <option key={f.key} value={f.key}>
              {f.label}
            </option>
          ))}
        </select>

        {formItems.map((item, i) => (
          <div className="demo-item-row" key={i}>
            <input
              type="text"
              placeholder="Item name"
              value={item.name}
              onChange={(e) => updateFormItem(i, { name: e.target.value })}
              disabled={formBusy}
            />
            <input
              type="number"
              min="1"
              step="1"
              placeholder="Qty"
              value={item.quantity}
              onChange={(e) => updateFormItem(i, { quantity: e.target.value })}
              disabled={formBusy}
            />
            <input
              type="number"
              min="0.01"
              step="0.01"
              placeholder="Unit price (₹)"
              value={item.unitPriceRupees}
              onChange={(e) => updateFormItem(i, { unitPriceRupees: e.target.value })}
              disabled={formBusy}
            />
            <select
              value={item.taxRateBp}
              onChange={(e) => updateFormItem(i, { taxRateBp: Number(e.target.value) })}
              disabled={formBusy}
            >
              {TAX_RATES.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            {formItems.length > 1 && (
              <button
                type="button"
                className="demo-remove-item"
                onClick={() => removeFormItem(i)}
                disabled={formBusy}
                aria-label={`Remove item ${i + 1}`}
              >
                ✕
              </button>
            )}
          </div>
        ))}

        <button onClick={addFormItem} disabled={formBusy || formItems.length >= MAX_FORM_ITEMS} className="demo-add-item">
          + Add item
        </button>

        <button onClick={createInvoiceFromForm} disabled={formBusy}>
          {formBusy ? 'Creating…' : 'Create Invoice'}
        </button>
        <ResultPanel result={formResult} />
      </section>
    </div>
  );
}
