import { formatCallbackDateTime } from './date-format';

// Block-type enum per D-10 (docs/DECISIONS_v1.md) — the only valid layoutSchema block
// types for v1. Expected to grow further (COUPON, SURVEY, MARKETING per the FSD).
const KNOWN_BLOCK_TYPES = ['HEADER', 'MERCHANT_INFO', 'ITEMS', 'PAYMENT_DETAILS', 'TOTAL', 'FOOTER'] as const;
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
  // Single row, not a real item-by-item breakdown: the callback carries no line items
  // (FSD BR-23 confirms a Payment Receipt has no line-item section). Kept as a genuine
  // ITEMS block, not repurposed, so the Tax Invoice path can use it for real rows later.
  | { type: 'ITEMS'; totalPaise: string; currency: string }
  | {
      type: 'PAYMENT_DETAILS';
      paymentMode: string | null | undefined;
      cardNetwork: string | null | undefined;
      paymentInstId: string | null | undefined;
      merchantTxnNo: string | null | undefined;
    }
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
    case 'ITEMS':
      return { type: 'ITEMS', ...renderMoneyFields(snapshot) };
    case 'PAYMENT_DETAILS':
      return {
        type: 'PAYMENT_DETAILS',
        paymentMode: snapshot.paymentMode,
        cardNetwork: snapshot.cardNetwork,
        paymentInstId: snapshot.paymentInstId,
        merchantTxnNo: snapshot.merchantTxnNo,
      };
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
