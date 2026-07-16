// Block-type enum per D-10 (docs/DECISIONS_v1.md) — the only valid layoutSchema block types for v1.
const KNOWN_BLOCK_TYPES = ['HEADER', 'MERCHANT_INFO', 'ITEMS', 'TOTAL', 'FOOTER'] as const;
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
}

export type RenderedBlock =
  | { type: 'HEADER'; merchantName: string | undefined }
  | { type: 'MERCHANT_INFO'; merchantName: string | undefined }
  | { type: 'ITEMS'; totalPaise: string; currency: string }
  | { type: 'TOTAL'; totalPaise: string; currency: string }
  | { type: 'FOOTER'; paymentMode: string | null | undefined; paymentDateTime: string | null | undefined };

// A blank amount on a paid bill is a worse failure than a blank name/date field would
// be — silently empty money reads as "nothing to pay" rather than "data problem" to a
// customer. So unlike other fields, a missing money value gets an explicit visible
// marker instead of undefined.
const AMOUNT_UNAVAILABLE = 'Amount unavailable';

function isKnownBlockType(type: string): type is BlockType {
  return (KNOWN_BLOCK_TYPES as readonly string[]).includes(type);
}

function renderMoneyFields(snapshot: BillSnapshot): { totalPaise: string; currency: string } {
  return {
    totalPaise: snapshot.amountPaise ?? AMOUNT_UNAVAILABLE,
    currency: snapshot.currency ?? AMOUNT_UNAVAILABLE,
  };
}

function renderBlock(block: LayoutBlock, snapshot: BillSnapshot): RenderedBlock {
  if (!isKnownBlockType(block.type)) {
    // D-10: any type outside the enum is invalid and must be rejected, not silently
    // skipped or passed through — this is a schema violation, not missing data.
    throw new Error(`Unknown block type: ${block.type}`);
  }

  switch (block.type) {
    case 'HEADER':
      return { type: 'HEADER', merchantName: snapshot.merchantName };
    case 'MERCHANT_INFO':
      return { type: 'MERCHANT_INFO', merchantName: snapshot.merchantName };
    case 'ITEMS':
      // Bill.snapshot as P-1 writes it today has no items[] array — it only carries a
      // single amountPaise total. So ITEMS renders one total line, not a real
      // item-by-item breakdown. This is a known v1 limitation inherited from P-1's
      // snapshot shape, not a renderer bug.
      return { type: 'ITEMS', ...renderMoneyFields(snapshot) };
    case 'TOTAL':
      return { type: 'TOTAL', ...renderMoneyFields(snapshot) };
    case 'FOOTER':
      return { type: 'FOOTER', paymentMode: snapshot.paymentMode, paymentDateTime: snapshot.paymentDateTime };
  }
}

export function renderTemplate(layoutSchema: LayoutBlock[], snapshot: BillSnapshot): RenderedBlock[] {
  return [...layoutSchema].sort((a, b) => a.order - b.order).map((block) => renderBlock(block, snapshot));
}
