import { formatMoney } from './money-format';

export function isPresent(value: string | null | undefined): value is string {
  return value != null && value !== '';
}

const MONEY_FIELDS = new Set(['unitPricePaise', 'discountPaise', 'taxableValuePaise', 'taxPaise', 'amountPaise']);

// Generic field formatter for columns-driven rows (§2/§9), shared by RETAIL
// (BillBlocks.tsx) and TAX_COMPLIANT (TaxInvoiceCard.tsx) — the renderer knows field
// TYPES (money vs rate vs plain), not field NAMES for layout purposes.
export function formatFieldValue(field: string, value: string | number | undefined, currency: string): string {
  if (value === undefined) return '';
  if (MONEY_FIELDS.has(field)) return formatMoney(String(value), currency);
  if (field === 'taxRateBp') return `${Number(value) / 100}%`;
  return String(value);
}
