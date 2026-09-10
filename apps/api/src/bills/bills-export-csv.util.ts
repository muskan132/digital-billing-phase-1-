// E-2 / D-71 / D-81: the two CSV serializers for GET /portal/bills/export.csv.
// Pure functions — the key-set tests run against them directly (E-2 verify:
// "at the serializer, not the controller"). Emits no diagnostic output; the
// E-2 deny-test scans this file for any such reference.
//
// Both projections share 8 columns; they differ ONLY in the two contact
// columns:
//   masked -> customer_mobile_masked, customer_email_masked  (H-1's masks)
//   full   -> customer_mobile, customer_email                (raw _pii columns)
// "D-48's detail field set" for `full` (D-81) = raw mobile + raw email +
// Broadcast.status as the scalar delivery_status. NOTHING else: no line items,
// no GSTIN, no subtotals, no broadcasts[], no raw Broadcast.recipient.
import { maskEmailPortal, maskMobilePortal } from '../common/portal-contact-mask.util';
import { ExportBillRow } from './portal-bills.service';
import { ExportContactProjection } from './pii-export-audit.service';

const SHARED_HEADERS = ['bill_id', 'created_at', 'bill_type', 'source', 'invoice_number', 'total_paise', 'currency', 'delivery_status'] as const;
const MASKED_HEADERS = [...SHARED_HEADERS, 'customer_mobile_masked', 'customer_email_masked'] as const;
const FULL_HEADERS = [...SHARED_HEADERS, 'customer_mobile', 'customer_email'] as const;

export const BILLS_CSV_MASKED_HEADERS: readonly string[] = MASKED_HEADERS;
export const BILLS_CSV_FULL_HEADERS: readonly string[] = FULL_HEADERS;

// RFC 4180 quoting + spreadsheet formula-injection guard (D-81). Applied to
// every field so a comma/quote/newline in caller-supplied free text
// (invoice_number, contact) can never break the row shape, and a leading
// =/+/-/@ can never be evaluated as a formula on open.
function csvField(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  if (/[",\r\n]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

function sharedFields(row: ExportBillRow): string[] {
  return [
    csvField(row.id),
    csvField(row.createdAt.toISOString()),
    csvField(row.billType),
    csvField(row.source),
    csvField(row.invoiceNumber),
    csvField(row.totalPaise.toString()), // BigInt -> string, never a number
    csvField(row.currency),
    csvField(row.deliveryStatus), // '' when the order has no broadcast (D-12)
  ];
}

function render(headers: readonly string[], rows: string[][]): string {
  // \r\n line endings per RFC 4180; a trailing newline so `wc -l` / a naive
  // splitter counts header + N data rows cleanly.
  return [headers.join(','), ...rows.map((r) => r.join(','))].join('\r\n') + '\r\n';
}

export function serializeBillsMasked(rows: ExportBillRow[]): string {
  return render(
    MASKED_HEADERS,
    rows.map((row) => [
      ...sharedFields(row),
      csvField(maskMobilePortal(row.customerMobile)),
      csvField(maskEmailPortal(row.customerEmail)),
    ]),
  );
}

export function serializeBillsFull(rows: ExportBillRow[]): string {
  return render(
    FULL_HEADERS,
    rows.map((row) => [
      ...sharedFields(row),
      csvField(row.customerMobile), // raw customerMobile_pii — D-48 detail authorizes this
      csvField(row.customerEmail), // raw customerEmail_pii
    ]),
  );
}

export function serializeBillsCsv(rows: ExportBillRow[], projection: ExportContactProjection): string {
  return projection === 'full' ? serializeBillsFull(rows) : serializeBillsMasked(rows);
}
