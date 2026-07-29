import { formatCallbackDateTime } from './date-format';

// Block-type enum per D-10 (docs/DECISIONS_v1.md) — the only valid layoutSchema block
// types for v1. Expected to grow further (COUPON, SURVEY, MARKETING per the FSD).
const KNOWN_BLOCK_TYPES = ['HEADER', 'MERCHANT_INFO', 'ITEMS', 'PAYMENT_DETAILS', 'TAX_SUMMARY', 'TOTAL', 'FOOTER'] as const;
type BlockType = (typeof KNOWN_BLOCK_TYPES)[number];

export interface LayoutBlock {
  type: string;
  order: number;
  props: Record<string, unknown>;
}

// Bill.snapshot as P-1 (apps/api/src/callbacks/callbacks.service.ts) actually writes it.
// All fields optional here: a missing field is a data-completeness gap, not a schema
// error, so it never throws. Non-money fields render blank; amountPaise/currency
// render an explicit "Amount unavailable" marker instead (see AMOUNT_UNAVAILABLE below).
export interface BillSnapshot {
  merchantName?: string;
  amountPaise?: string;
  currency?: string;
  paymentMode?: string | null;
  paymentDateTime?: string | null;
  receiptNumber?: string | null;
  merchantTxnNo?: string | null;
  cardNetwork?: string | null;
  paymentInstId?: string | null;
  respDescription?: string | null;
  // v2 (D-28): TAX_INVOICE-only fields, absent on a RECEIPT snapshot.
  invoiceNumber?: string;
  placeOfSupply?: string;
  merchantGstin?: string | null;
  merchantState?: string | null;
  merchantAddress?: string | null;
  subtotalPaise?: string;
  discountPaise?: string;
  taxPaise?: string;
  cgstPaise?: string;
  sgstPaise?: string;
  igstPaise?: string;
  items?: BillSnapshotLineItem[];
}

// Mirrors P-2's exact D-28 items[] member shape (apps/api/src/bills/bills.service.ts).
export interface BillSnapshotLineItem {
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

// One row per invoice line, as rendered (V-5). discountPaise combines itemDiscountPaise
// + billDiscountAllocPaise into the single "discount" column the printed line needs so
// unitPrice*qty - discount = taxable reconciles visually, even though the two discount
// components are stored separately (D-22/D-23) — display-only combination, the
// underlying stored values are untouched.
export interface RenderedLineItem {
  lineNo: number;
  name: string;
  hsn: string;
  uom: string;
  quantity: number;
  unitPricePaise: string;
  discountPaise: string;
  taxRateBp: number;
  taxableValuePaise: string;
  taxPaise: string;
}

// One row per distinct tax rate, summed across all lines at that rate (V-5).
export interface TaxSummaryRow {
  taxRateBp: number;
  taxableValuePaise: string;
  cgstPaise: string;
  sgstPaise: string;
  igstPaise: string;
}

// Merchant business details as L-2 (apps/api/src/links/links.service.ts) whitelists
// them — the equivalent of what's printed on any shop receipt, not customer PII.
export interface BillMerchant {
  name?: string;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  state?: string | null;
  pincode?: string | null;
  gstin?: string | null;
  supportEmail?: string | null;
  supportPhone?: string | null;
}

export type RenderedBlock =
  | {
      type: 'HEADER';
      merchantName: string | undefined;
      receiptNumber: string | null | undefined;
      formattedDateTime: string | null;
    }
  | {
      type: 'MERCHANT_INFO';
      addressLine1: string | null | undefined;
      addressLine2: string | null | undefined;
      city: string | null | undefined;
      state: string | null | undefined;
      pincode: string | null | undefined;
      gstin: string | null | undefined;
    }
  // 'single': no line items on the snapshot (RECEIPT bills — FSD BR-23 confirms a
  // Payment Receipt has no line-item section) — the original one-row summary.
  // 'itemized' (V-5): real per-line rows for a TAX_INVOICE snapshot.
  | { type: 'ITEMS'; kind: 'single'; totalPaise: string; currency: string }
  | { type: 'ITEMS'; kind: 'itemized'; items: RenderedLineItem[]; currency: string }
  | {
      type: 'PAYMENT_DETAILS';
      paymentMode: string | null | undefined;
      cardNetwork: string | null | undefined;
      paymentInstId: string | null | undefined;
      merchantTxnNo: string | null | undefined;
    }
  // V-5: CGST/SGST-or-IGST breakdown grouped by tax rate.
  //
  // KNOWN LIMITATION (flagged, not fixed — would require reopening P-2/L-3's locked
  // schema): isIntraState is derived from whether igstPaise is zero/absent. A fully
  // zero-rated bill (every line taxRateBp=0) produces cgst=sgst=igst=0 regardless of
  // the bill's actual place of supply, because D-24's split logic yields 0/0 whenever
  // tax=0 — the information needed to disambiguate intra- vs inter-state does not
  // survive into the zero values. A fully-exempt inter-state invoice may therefore
  // display under the wrong tax-type label (CGST/SGST columns shown instead of IGST,
  // or vice versa). Practical impact is low — every figure shown is zero either way —
  // but it is a labeling-correctness gap on a compliance document.
  | { type: 'TAX_SUMMARY'; isIntraState: boolean; rows: TaxSummaryRow[]; currency: string }
  | { type: 'TOTAL'; totalPaise: string; currency: string }
  | {
      type: 'FOOTER';
      supportEmail: string | null | undefined;
      supportPhone: string | null | undefined;
    };

// A blank amount on a paid bill is a worse failure than a blank name/date field would
// be — silently empty money reads as "nothing to pay" rather than "data problem" to a
// customer. So unlike other fields, a missing money value gets an explicit visible
// marker instead of undefined.
export const AMOUNT_UNAVAILABLE = 'Amount unavailable';

function isKnownBlockType(type: string): type is BlockType {
  return (KNOWN_BLOCK_TYPES as readonly string[]).includes(type);
}

function renderMoneyFields(snapshot: BillSnapshot): { totalPaise: string; currency: string } {
  return {
    totalPaise: snapshot.amountPaise ?? AMOUNT_UNAVAILABLE,
    currency: snapshot.currency ?? AMOUNT_UNAVAILABLE,
  };
}

function renderBlock(block: LayoutBlock, snapshot: BillSnapshot, merchant: BillMerchant): RenderedBlock {
  if (!isKnownBlockType(block.type)) {
    // D-10: any type outside the enum is invalid and must be rejected, not silently
    // skipped or passed through — this is a schema violation, not missing data.
    throw new Error(`Unknown block type: ${block.type}`);
  }

  switch (block.type) {
    case 'HEADER':
      return {
        type: 'HEADER',
        merchantName: merchant.name ?? snapshot.merchantName,
        receiptNumber: snapshot.receiptNumber,
        formattedDateTime: formatCallbackDateTime(snapshot.paymentDateTime),
      };
    case 'MERCHANT_INFO':
      return {
        type: 'MERCHANT_INFO',
        addressLine1: merchant.addressLine1,
        addressLine2: merchant.addressLine2,
        city: merchant.city,
        state: merchant.state,
        pincode: merchant.pincode,
        gstin: merchant.gstin,
      };
    case 'ITEMS': {
      if (snapshot.items && snapshot.items.length > 0) {
        return {
          type: 'ITEMS',
          kind: 'itemized',
          currency: snapshot.currency ?? AMOUNT_UNAVAILABLE,
          items: snapshot.items.map((item) => ({
            lineNo: item.lineNo,
            name: item.name,
            hsn: item.hsn,
            uom: item.uom,
            quantity: item.quantity,
            unitPricePaise: item.unitPricePaise,
            // Display-only combination — see RenderedLineItem's comment.
            discountPaise: (BigInt(item.itemDiscountPaise) + BigInt(item.billDiscountAllocPaise)).toString(),
            taxRateBp: item.taxRateBp,
            taxableValuePaise: item.taxableValuePaise,
            taxPaise: item.taxPaise,
          })),
        };
      }
      return { type: 'ITEMS', kind: 'single', ...renderMoneyFields(snapshot) };
    }
    case 'PAYMENT_DETAILS':
      return {
        type: 'PAYMENT_DETAILS',
        paymentMode: snapshot.paymentMode,
        cardNetwork: snapshot.cardNetwork,
        paymentInstId: snapshot.paymentInstId,
        merchantTxnNo: snapshot.merchantTxnNo,
      };
    case 'TAX_SUMMARY': {
      const items = snapshot.items ?? [];
      const groups = new Map<
        number,
        { taxableValuePaise: bigint; cgstPaise: bigint; sgstPaise: bigint; igstPaise: bigint }
      >();
      for (const item of items) {
        const g = groups.get(item.taxRateBp) ?? {
          taxableValuePaise: BigInt(0),
          cgstPaise: BigInt(0),
          sgstPaise: BigInt(0),
          igstPaise: BigInt(0),
        };
        g.taxableValuePaise += BigInt(item.taxableValuePaise);
        g.cgstPaise += BigInt(item.cgstPaise);
        g.sgstPaise += BigInt(item.sgstPaise);
        g.igstPaise += BigInt(item.igstPaise);
        groups.set(item.taxRateBp, g);
      }
      const rows: TaxSummaryRow[] = [...groups.entries()]
        .sort(([a], [b]) => a - b)
        .map(([taxRateBp, g]) => ({
          taxRateBp,
          taxableValuePaise: g.taxableValuePaise.toString(),
          cgstPaise: g.cgstPaise.toString(),
          sgstPaise: g.sgstPaise.toString(),
          igstPaise: g.igstPaise.toString(),
        }));
      // See the KNOWN LIMITATION comment on the TAX_SUMMARY case of RenderedBlock above
      // — this derivation cannot distinguish a genuinely intra-state bill from a fully
      // zero-rated inter-state one.
      const isIntraState = !snapshot.igstPaise || snapshot.igstPaise === '0';
      return { type: 'TAX_SUMMARY', isIntraState, rows, currency: snapshot.currency ?? AMOUNT_UNAVAILABLE };
    }
    case 'TOTAL':
      return { type: 'TOTAL', ...renderMoneyFields(snapshot) };
    case 'FOOTER':
      return {
        type: 'FOOTER',
        supportEmail: merchant.supportEmail,
        supportPhone: merchant.supportPhone,
      };
  }
}

export function renderTemplate(
  layoutSchema: LayoutBlock[],
  snapshot: BillSnapshot,
  merchant: BillMerchant = {},
): RenderedBlock[] {
  return [...layoutSchema].sort((a, b) => a.order - b.order).map((block) => renderBlock(block, snapshot, merchant));
}
