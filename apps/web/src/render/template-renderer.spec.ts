import { renderTemplate, LayoutBlock, BillSnapshot, BillSnapshotLineItem, BillMerchant } from './template-renderer';

// Mirrors apps/api/prisma/seed.ts's RECEIPT_LAYOUT_SCHEMA (shared by both skeletons).
const SEEDED_LAYOUT_SCHEMA: LayoutBlock[] = [
  { type: 'HEADER', order: 1, props: {} },
  { type: 'MERCHANT_INFO', order: 2, props: {} },
  { type: 'ITEMS', order: 3, props: {} },
  { type: 'TOTAL', order: 4, props: {} },
  { type: 'PAYMENT_DETAILS', order: 5, props: {} },
  { type: 'FOOTER', order: 6, props: {} },
];

// Mirrors apps/api/prisma/seed.ts's taxInvoiceTemplateData.layoutSchema (T-2). No
// shared source between the two packages — kept in sync by hand; see the "known gap"
// noted in T-2's summary about a possible future shared-constants/runtime check.
const SEEDED_TAX_COMPLIANT_LAYOUT_SCHEMA: LayoutBlock[] = [
  { type: 'HEADER', order: 1, props: {} },
  { type: 'MERCHANT_INFO', order: 2, props: {} },
  { type: 'ITEMS', order: 3, props: {} },
  { type: 'TAX_SUMMARY', order: 4, props: {} },
  { type: 'TOTAL', order: 5, props: {} },
  { type: 'FOOTER', order: 6, props: {} },
];

// Mirrors the snapshot shape apps/api/src/callbacks/callbacks.service.ts (P-1) writes.
const SAMPLE_SNAPSHOT: BillSnapshot = {
  merchantName: 'Demo Merchant',
  amountPaise: '100',
  currency: 'INR',
  paymentMode: 'Card',
  paymentDateTime: '20250910123438',
  receiptNumber: '7700206148341-001',
  merchantTxnNo: 'UAT1280835036',
  cardNetwork: 'VISA',
  paymentInstId: '4XXX XXXX XXXX 1111',
  respDescription: 'Transaction successful',
};

// Mirrors P-2's exact D-28 snapshot shape for a TAX_INVOICE, two lines at different
// tax rates, intra-state (matches the sample-bill.json fixture from apps/api).
const TAX_INVOICE_ITEMS: BillSnapshotLineItem[] = [
  {
    lineNo: 1,
    name: 'Wireless Mouse',
    hsn: '8471',
    uom: 'NOS',
    quantity: 2,
    unitPricePaise: '10000',
    itemDiscountPaise: '0',
    billDiscountAllocPaise: '0',
    taxRateBp: 500,
    taxableValuePaise: '20000',
    taxPaise: '1000',
    cgstPaise: '500',
    sgstPaise: '500',
    igstPaise: '0',
  },
  {
    lineNo: 2,
    name: 'USB-C Cable',
    hsn: '8544',
    uom: 'NOS',
    quantity: 1,
    unitPricePaise: '5000',
    itemDiscountPaise: '0',
    billDiscountAllocPaise: '0',
    taxRateBp: 1800,
    taxableValuePaise: '5000',
    taxPaise: '900',
    cgstPaise: '450',
    sgstPaise: '450',
    igstPaise: '0',
  },
];

const TAX_INVOICE_SNAPSHOT: BillSnapshot = {
  merchantName: 'Demo Merchant',
  currency: 'INR',
  invoiceNumber: 'INV-2026-0001',
  placeOfSupply: '27',
  merchantGstin: '27ABCDE1234F1Z5',
  subtotalPaise: '25000',
  discountPaise: '0',
  taxPaise: '1900',
  cgstPaise: '950',
  sgstPaise: '950',
  igstPaise: '0',
  items: TAX_INVOICE_ITEMS,
};

const INTER_STATE_TAX_INVOICE_SNAPSHOT: BillSnapshot = {
  ...TAX_INVOICE_SNAPSHOT,
  placeOfSupply: '29',
  cgstPaise: '0',
  sgstPaise: '0',
  igstPaise: '1900',
  items: TAX_INVOICE_ITEMS.map((item) => ({
    ...item,
    cgstPaise: '0',
    sgstPaise: '0',
    igstPaise: item.taxPaise,
  })),
};

// Mirrors L-2's whitelisted merchant shape.
const SAMPLE_MERCHANT: BillMerchant = {
  name: 'Demo Merchant',
  addressLine1: '221, Linking Road',
  addressLine2: 'Bandra West',
  city: 'Mumbai',
  state: 'Maharashtra',
  pincode: '400050',
  gstin: '27ABCDE1234F1Z5',
  supportEmail: 'support@demo-merchant.test',
  supportPhone: '+91 22 4000 1234',
};

describe('renderTemplate', () => {
  it('produces expected blocks in order for a seeded template + sample snapshot/merchant', () => {
    const result = renderTemplate(SEEDED_LAYOUT_SCHEMA, SAMPLE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([
      {
        type: 'HEADER',
        merchantName: 'Demo Merchant',
        receiptNumber: '7700206148341-001',
        formattedDateTime: '10 Sep 2025, 12:34 PM',
      },
      {
        type: 'MERCHANT_INFO',
        addressLine1: '221, Linking Road',
        addressLine2: 'Bandra West',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400050',
        gstin: '27ABCDE1234F1Z5',
      },
      { type: 'ITEMS', kind: 'single', totalPaise: '100', currency: 'INR' },
      { type: 'TOTAL', totalPaise: '100', currency: 'INR' },
      {
        type: 'PAYMENT_DETAILS',
        paymentMode: 'Card',
        cardNetwork: 'VISA',
        paymentInstId: '4XXX XXXX XXXX 1111',
        merchantTxnNo: 'UAT1280835036',
      },
      { type: 'FOOTER', supportEmail: 'support@demo-merchant.test', supportPhone: '+91 22 4000 1234' },
    ]);
  });

  it('renders blocks in layoutSchema order regardless of array order', () => {
    const shuffled: LayoutBlock[] = [
      { type: 'FOOTER', order: 6, props: {} },
      { type: 'PAYMENT_DETAILS', order: 5, props: {} },
      { type: 'TOTAL', order: 4, props: {} },
      { type: 'ITEMS', order: 3, props: {} },
      { type: 'HEADER', order: 1, props: {} },
      { type: 'MERCHANT_INFO', order: 2, props: {} },
    ];

    const result = renderTemplate(shuffled, SAMPLE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result.map((block) => block.type)).toEqual([
      'HEADER',
      'MERCHANT_INFO',
      'ITEMS',
      'TOTAL',
      'PAYMENT_DETAILS',
      'FOOTER',
    ]);
  });

  it('renders blank/undefined values for non-money fields missing from snapshot/merchant, without throwing', () => {
    const result = renderTemplate([{ type: 'HEADER', order: 1, props: {} }], {});

    expect(result).toEqual([{ type: 'HEADER', merchantName: undefined, receiptNumber: undefined, formattedDateTime: null }]);
  });

  it('renders an explicit "Amount unavailable" marker for TOTAL/ITEMS when amountPaise/currency are missing, without throwing', () => {
    const result = renderTemplate(
      [
        { type: 'ITEMS', order: 1, props: {} },
        { type: 'TOTAL', order: 2, props: {} },
      ],
      {},
    );

    expect(result).toEqual([
      { type: 'ITEMS', kind: 'single', totalPaise: 'Amount unavailable', currency: 'Amount unavailable' },
      { type: 'TOTAL', totalPaise: 'Amount unavailable', currency: 'Amount unavailable' },
    ]);
  });

  it('PAYMENT_DETAILS carries paymentInstId as null when absent (non-card payment mode), without throwing', () => {
    const result = renderTemplate(
      [{ type: 'PAYMENT_DETAILS', order: 1, props: {} }],
      { paymentMode: 'UPI', cardNetwork: null, paymentInstId: null, merchantTxnNo: 'mtxn_1' },
    );

    expect(result).toEqual([
      { type: 'PAYMENT_DETAILS', paymentMode: 'UPI', cardNetwork: null, paymentInstId: null, merchantTxnNo: 'mtxn_1' },
    ]);
  });

  it('guards unknown block types by throwing (D-10)', () => {
    const invalidSchema = [{ type: 'BOGUS', order: 1, props: {} }] as LayoutBlock[];

    expect(() => renderTemplate(invalidSchema, SAMPLE_SNAPSHOT, SAMPLE_MERCHANT)).toThrow(/Unknown block type/);
  });

  it('renders TAX_SUMMARY with no rows when the snapshot has no items (e.g. a RECEIPT snapshot), without throwing', () => {
    const result = renderTemplate([{ type: 'TAX_SUMMARY', order: 1, props: {} }], SAMPLE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([{ type: 'TAX_SUMMARY', isIntraState: true, rows: [], currency: 'INR' }]);
  });

  it('renders the seeded TAX_COMPLIANT layoutSchema (T-2) end-to-end without throwing', () => {
    const result = renderTemplate(SEEDED_TAX_COMPLIANT_LAYOUT_SCHEMA, SAMPLE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result.map((block) => block.type)).toEqual(['HEADER', 'MERCHANT_INFO', 'ITEMS', 'TAX_SUMMARY', 'TOTAL', 'FOOTER']);
  });

  // ---- V-5: itemized ITEMS ----

  it('V-5: renders itemized ITEMS with real line items, combining item+bill discount into one column (D-22/D-23)', () => {
    const result = renderTemplate([{ type: 'ITEMS', order: 1, props: {} }], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([
      {
        type: 'ITEMS',
        kind: 'itemized',
        currency: 'INR',
        items: [
          {
            lineNo: 1,
            name: 'Wireless Mouse',
            hsn: '8471',
            uom: 'NOS',
            quantity: 2,
            unitPricePaise: '10000',
            discountPaise: '0', // itemDiscountPaise (0) + billDiscountAllocPaise (0)
            taxRateBp: 500,
            taxableValuePaise: '20000',
            taxPaise: '1000',
          },
          {
            lineNo: 2,
            name: 'USB-C Cable',
            hsn: '8544',
            uom: 'NOS',
            quantity: 1,
            unitPricePaise: '5000',
            discountPaise: '0',
            taxRateBp: 1800,
            taxableValuePaise: '5000',
            taxPaise: '900',
          },
        ],
      },
    ]);
  });

  it('V-5: combines a nonzero itemDiscountPaise and billDiscountAllocPaise into one discountPaise figure', () => {
    const snapshot: BillSnapshot = {
      ...TAX_INVOICE_SNAPSHOT,
      items: [{ ...TAX_INVOICE_ITEMS[0], itemDiscountPaise: '150', billDiscountAllocPaise: '25' }],
    };

    const result = renderTemplate([{ type: 'ITEMS', order: 1, props: {} }], snapshot, SAMPLE_MERCHANT);

    expect(result).toEqual([
      expect.objectContaining({
        type: 'ITEMS',
        kind: 'itemized',
        items: [expect.objectContaining({ discountPaise: '175' })],
      }),
    ]);
  });

  it('V-5: falls back to the single-row ITEMS style when snapshot.items is absent (RECEIPT bills unaffected)', () => {
    const result = renderTemplate([{ type: 'ITEMS', order: 1, props: {} }], SAMPLE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([{ type: 'ITEMS', kind: 'single', totalPaise: '100', currency: 'INR' }]);
  });

  // ---- V-5: TAX_SUMMARY grouped by rate ----

  it('V-5: TAX_SUMMARY groups by tax rate and sums exactly, intra-state shows CGST+SGST (isIntraState: true)', () => {
    const result = renderTemplate([{ type: 'TAX_SUMMARY', order: 1, props: {} }], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([
      {
        type: 'TAX_SUMMARY',
        isIntraState: true,
        currency: 'INR',
        rows: [
          { taxRateBp: 500, taxableValuePaise: '20000', cgstPaise: '500', sgstPaise: '500', igstPaise: '0' },
          { taxRateBp: 1800, taxableValuePaise: '5000', cgstPaise: '450', sgstPaise: '450', igstPaise: '0' },
        ],
      },
    ]);
  });

  it('V-5: TAX_SUMMARY shows IGST for an inter-state bill (isIntraState: false), no CGST/SGST', () => {
    const result = renderTemplate(
      [{ type: 'TAX_SUMMARY', order: 1, props: {} }],
      INTER_STATE_TAX_INVOICE_SNAPSHOT,
      SAMPLE_MERCHANT,
    );

    expect(result).toEqual([
      {
        type: 'TAX_SUMMARY',
        isIntraState: false,
        currency: 'INR',
        rows: [
          { taxRateBp: 500, taxableValuePaise: '20000', cgstPaise: '0', sgstPaise: '0', igstPaise: '1000' },
          { taxRateBp: 1800, taxableValuePaise: '5000', cgstPaise: '0', sgstPaise: '0', igstPaise: '900' },
        ],
      },
    ]);
  });

  it('V-5: sums multiple lines at the same tax rate into one grouped row, via BigInt (no float)', () => {
    const snapshot: BillSnapshot = {
      ...TAX_INVOICE_SNAPSHOT,
      items: [
        { ...TAX_INVOICE_ITEMS[0], lineNo: 1, taxRateBp: 500, taxableValuePaise: '20000', taxPaise: '1000', cgstPaise: '500', sgstPaise: '500' },
        { ...TAX_INVOICE_ITEMS[0], lineNo: 2, taxRateBp: 500, taxableValuePaise: '10000', taxPaise: '500', cgstPaise: '250', sgstPaise: '250' },
      ],
    };

    const result = renderTemplate([{ type: 'TAX_SUMMARY', order: 1, props: {} }], snapshot, SAMPLE_MERCHANT);

    expect(result).toEqual([
      {
        type: 'TAX_SUMMARY',
        isIntraState: true,
        currency: 'INR',
        rows: [{ taxRateBp: 500, taxableValuePaise: '30000', cgstPaise: '750', sgstPaise: '750', igstPaise: '0' }],
      },
    ]);
  });

  // ---- V-5: per-line taxes sum exactly to the printed total (verify-locally) ----

  it('V-5: the sum of rendered per-line taxes equals the bill-level tax used by TOTAL', () => {
    const layout: LayoutBlock[] = [
      { type: 'ITEMS', order: 1, props: {} },
      { type: 'TOTAL', order: 2, props: {} },
    ];
    const result = renderTemplate(layout, TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    const itemsBlock = result[0];
    if (itemsBlock.type !== 'ITEMS' || itemsBlock.kind !== 'itemized') throw new Error('expected itemized ITEMS');
    const sumOfLineTaxes = itemsBlock.items.reduce((acc, item) => acc + BigInt(item.taxPaise), BigInt(0));

    expect(sumOfLineTaxes.toString()).toBe(TAX_INVOICE_SNAPSHOT.taxPaise);
  });

  // ---- V-5: merchant-supplied item name is never sanitized/stripped by the data layer;
  // safety is JSX's default escaping in BillBlocks.tsx (no dangerouslySetInnerHTML,
  // confirmed absent anywhere in apps/web). See the comment above the item-name JSX. ----

  it('V-5: a <script> in an item name passes through renderTemplate unmodified as plain data', () => {
    const maliciousName = '<script>alert(1)</script>';
    const snapshot: BillSnapshot = {
      ...TAX_INVOICE_SNAPSHOT,
      items: [{ ...TAX_INVOICE_ITEMS[0], name: maliciousName }],
    };

    const result = renderTemplate([{ type: 'ITEMS', order: 1, props: {} }], snapshot, SAMPLE_MERCHANT);

    expect(result).toEqual([
      expect.objectContaining({
        type: 'ITEMS',
        kind: 'itemized',
        items: [expect.objectContaining({ name: maliciousName })],
      }),
    ]);
  });
});
