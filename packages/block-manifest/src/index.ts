export * from './normalize-layout';
export * from './validate-layout';

// The block manifest (D-30, docs/TEMPLATE_SYSTEM_v2.md §1) — the single
// declaration of what each block TYPE is: its prop shape, defaults, which
// data fields it can bind to, and which renderer draws it. This is the ONLY
// copy in the codebase; apps/web's renderer imports BLOCK_TYPES/BlockType
// from here rather than declaring its own (D-30 rejects duplication-plus-
// drift-test outright).
//
// Scope (T-3): covers only the block types actually rendered TODAY, read
// directly out of apps/web/src/render/template-renderer.ts's KNOWN_BLOCK_TYPES
// and cross-checked against every layoutSchema in apps/api/prisma/seed.ts.
// This is 14 types, not the full 22-block catalogue in TEMPLATE_SYSTEM_v2.md
// §3 — the 8 unused ones (CHARGES, SAVINGS's utility cousins, CONSUMER_INFO,
// METER_READING, DUE_DATE, PAY_NOW, USAGE_COMPARISON, BILL_TO, MARKETING,
// CUSTOM_CONTENT) have no renderer yet and are deliberately left out rather
// than declared speculatively.

export const BLOCK_TYPES = [
  'HEADER',
  'MERCHANT_INFO',
  'BILL_META',
  'ITEMS',
  'PAYMENT_DETAILS',
  'TAX_SUMMARY',
  'TOTAL',
  'AMOUNT_PAYABLE',
  'SAVINGS',
  'LOYALTY',
  'COUPON',
  'SURVEY',
  'QR_CODE',
  'FOOTER',
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

export interface BlockPropSpec {
  type: 'string' | 'boolean' | 'columns' | 'stringArray';
  required: boolean;
  description: string;
}

export interface BlockManifestEntry {
  type: BlockType;
  description: string;
  // Per-type prop schema (§2's props object) — only props the renderer
  // actually reads today. Not a full JSON-schema; enough for the builder's
  // per-block prop editor (U-2) to generate a form from.
  props: Record<string, BlockPropSpec>;
  defaults: Record<string, unknown>;
  // Only set for blocks with a column-config (§2's field/label/visible/align
  // model) — the fixed list of `field` values a column may bind to. Absent
  // (not empty array) for every other block type, since "bindable to
  // nothing" and "not column-based" are different facts.
  bindableFields?: readonly string[];
  // Points at the switch case of the same name in
  // apps/web/src/render/template-renderer.ts (renderBlock) and
  // apps/web/src/render/BillBlocks.tsx (BillBlock) — both keyed on
  // block.type, so this is always identical to `type` today. Kept as an
  // explicit field because §1 requires the manifest to name "which renderer
  // draws it", not just imply it via the type string.
  renderer: string;
}

export const BLOCK_MANIFEST: Record<BlockType, BlockManifestEntry> = {
  HEADER: {
    type: 'HEADER',
    description: 'Merchant name, receipt/ref number, formatted date-time.',
    // template-renderer.ts's HEADER case reads nothing off block.props — every
    // field comes from `snapshot`/`merchant`. No props to declare today.
    props: {},
    defaults: {},
    renderer: 'HEADER',
  },
  MERCHANT_INFO: {
    type: 'MERCHANT_INFO',
    description:
      "Seller address/GSTIN. Two variants selected by props.variant: 'receipt' (default, live merchant fields) or 'tax_invoice' (frozen snapshot fields, BR-2 immutability — see template-renderer.ts's RenderedBlock comment on why tax_invoice never reads the live merchant param).",
    props: {
      variant: {
        type: 'string',
        required: false,
        description: "'tax_invoice' switches to the frozen-snapshot variant; anything else (including absent) renders 'receipt'.",
      },
    },
    defaults: {},
    renderer: 'MERCHANT_INFO',
  },
  BILL_META: {
    type: 'BILL_META',
    description: 'Bill number and date (§3 #3).',
    // §3's catalogue lists `fields[]` as this block's key prop, but the
    // current renderer (template-renderer.ts's BILL_META case) does not read
    // ANY prop — it only reads snapshot.invoiceNumber, and `date` is
    // hardcoded to `undefined`. Declaring a `fields[]` prop here would be
    // inventing a control the renderer doesn't implement (CLAUDE.md: never
    // invent an API field not already in the repo). Left empty on purpose —
    // update this entry only alongside the renderer, not ahead of it.
    props: {},
    defaults: {},
    renderer: 'BILL_META',
    // KNOWN GAP: `date` never renders — no date field exists anywhere on
    // Bill.snapshot yet (tracked in memory: project_tax_compliant_known_bugs.md
    // §3, not fabricated here). This block only ever shows bill number in
    // practice, regardless of what's configured.
  },
  ITEMS: {
    type: 'ITEMS',
    description:
      'Line-item table. Three render kinds depending on data/config, selected automatically (not by a props flag): "single" (no items on the snapshot — RECEIPT bills), "itemized" (items present, no props.columns — hardcoded fields), "columns" (items present AND props.columns declared — the field/label/visible/align builder contract, §2/§9). New templates should always use "columns".',
    props: {
      columns: {
        type: 'columns',
        required: false,
        description:
          'Array of { field, label, visible, align }. field is system-owned and never merchant-editable (§2). Presence of this prop (even empty) is what selects the "columns" render kind over "itemized".',
      },
      secondaryFields: {
        type: 'stringArray',
        required: false,
        description: 'Subset of bindableFields shown as a muted secondary line under each row (e.g. HSN on RETAIL).',
      },
    },
    defaults: { columns: [], secondaryFields: [] },
    // Exact field set a columns[].field / secondaryFields entry may bind to —
    // read directly off the `fields` object template-renderer.ts's ITEMS/columns
    // case builds per row. Anything outside this list is not renderable.
    bindableFields: ['name', 'hsn', 'uom', 'quantity', 'unitPricePaise', 'discountPaise', 'taxRateBp', 'taxableValuePaise', 'taxPaise', 'amountPaise'],
    renderer: 'ITEMS',
  },
  PAYMENT_DETAILS: {
    type: 'PAYMENT_DETAILS',
    description: 'Payment mode, masked card instrument, order reference.',
    // No props read — all fields come from snapshot. Live in both RECEIPT
    // templates (seed.ts's shared RECEIPT_LAYOUT_SCHEMA: Minimalist +
    // Compact Thermal) but absent from all three TAX_INVOICE templates
    // (TAX_COMPLIANT/RETAIL/RESTAURANT) — narrower usage than the other 13
    // block types here, not unused.
    props: {},
    defaults: {},
    renderer: 'PAYMENT_DETAILS',
  },
  TAX_SUMMARY: {
    type: 'TAX_SUMMARY',
    description:
      "Tax component ladder (§5). props.mode='auto' selects the corrected 'aggregate' shape (one CGST/SGST or IGST row, summed across all rates); absent props.mode falls back to the known-wrong 'legacy_matrix' shape kept only for TAX_COMPLIANT (see template-renderer.ts's TaxSummaryRow comment — tracked bug, not fixed here).",
    props: {
      mode: {
        type: 'string',
        required: false,
        description: "'auto' selects the correct §5 aggregate ladder. Any other value (including absent) keeps the legacy per-rate matrix.",
      },
    },
    defaults: {},
    renderer: 'TAX_SUMMARY',
  },
  TOTAL: {
    type: 'TOTAL',
    description:
      "Pre-tax total. props.basis='pre_tax' computes subtotalPaise - discountPaise (D-22's taxable value); absent props.basis renders snapshot.amountPaise (the grand total) instead — a naming quirk kept for the original RECEIPT skeletons' backward compatibility, not something new templates should rely on.",
    props: {
      basis: {
        type: 'string',
        required: false,
        description: "'pre_tax' computes subtotal-minus-discount. Any other value (including absent) shows the grand total.",
      },
    },
    defaults: {},
    renderer: 'TOTAL',
  },
  AMOUNT_PAYABLE: {
    type: 'AMOUNT_PAYABLE',
    description: 'Post-tax hero total (§3 #8) — distinct from TOTAL, see §5 document order.',
    props: {},
    defaults: {},
    renderer: 'AMOUNT_PAYABLE',
  },
  SAVINGS: {
    type: 'SAVINGS',
    description: '"You saved ₹X" callout (§3 #10).',
    props: {},
    defaults: {},
    renderer: 'SAVINGS',
    // KNOWN GAP: no data source anywhere in Bill.snapshot computes a savings
    // figure yet — savingsPaise is always undefined, and BillBlocks.tsx
    // renders nothing for this block today (not a bug, an expected gap).
  },
  LOYALTY: {
    type: 'LOYALTY',
    description: 'Points earned / balance (§3 #11).',
    props: {},
    defaults: {},
    renderer: 'LOYALTY',
    // KNOWN GAP: same as SAVINGS — no data source yet, always renders nothing.
  },
  COUPON: {
    type: 'COUPON',
    description: 'Offer code + validity (§3 #19). Template-authored static copy, frozen into layoutSnapshot at issue time — not bill-computed.',
    props: {
      headline: { type: 'string', required: false, description: 'Offer headline text.' },
      code: { type: 'string', required: false, description: 'Coupon/offer code.' },
      validity: { type: 'string', required: false, description: 'Validity text, e.g. "Valid for 30 days".' },
      ctaLabel: { type: 'string', required: false, description: 'Call-to-action label.' },
    },
    defaults: {},
    renderer: 'COUPON',
  },
  SURVEY: {
    type: 'SURVEY',
    description: 'Rating / feedback prompt (§3 #20). Template-authored static copy.',
    props: {
      prompt: { type: 'string', required: false, description: 'Prompt text shown to the customer.' },
      type: { type: 'string', required: false, description: "Survey type, e.g. 'rating'." },
      url: { type: 'string', required: false, description: 'Survey destination URL.' },
    },
    defaults: {},
    renderer: 'SURVEY',
  },
  QR_CODE: {
    type: 'QR_CODE',
    description:
      'Scannable engagement QR linking to a static offer page. NOT in TEMPLATE_SYSTEM_v2.md §3\'s original 22-block catalogue — added directly in code for RETAIL (see doc follow-up adding it as row 23). Template-authored static copy, same pattern as COUPON/SURVEY.',
    props: {
      path: { type: 'string', required: false, description: 'Path appended to PUBLIC_BILL_BASE_URL to form the QR target.' },
      caption: { type: 'string', required: false, description: 'Caption shown under the QR image.' },
    },
    defaults: {},
    renderer: 'QR_CODE',
    // Rendering is ALSO gated on skeleton === 'RETAIL' in BillBlocks.tsx,
    // independent of which template includes the block — a hardcoded
    // skeleton check, not something this manifest entry can express.
  },
  FOOTER: {
    type: 'FOOTER',
    description: 'Support contact, powered-by line.',
    // No props read — supportEmail/supportPhone come from the merchant param.
    props: {},
    defaults: {},
    renderer: 'FOOTER',
  },
};
