import { renderTemplate, LayoutBlock, BillSnapshot, BillSnapshotLineItem, BillMerchant, ColumnConfig } from './template-renderer';

// Mirrors apps/api/prisma/seed.ts's RECEIPT_LAYOUT_SCHEMA (shared by both skeletons).
const SEEDED_LAYOUT_SCHEMA: LayoutBlock[] = [
  { type: 'HEADER', order: 1, props: {} },
  { type: 'MERCHANT_INFO', order: 2, props: {} },
  { type: 'ITEMS', order: 3, props: {} },
  { type: 'TOTAL', order: 4, props: {} },
  { type: 'PAYMENT_DETAILS', order: 5, props: {} },
  { type: 'FOOTER', order: 6, props: {} },
];

// Mirrors apps/api/prisma/seed.ts's taxInvoiceTemplateData.layoutSchema exactly (BUG 1
// + BUG 2 fixes). No shared source between the two packages — kept in sync by hand; see
// the "known gap" noted in T-2's summary about a possible future shared-constants/
// runtime check.
const TAX_COMPLIANT_ITEMS_COLUMNS: ColumnConfig[] = [
  { field: 'name', label: 'DESCRIPTION', visible: true, align: 'left' },
  { field: 'hsn', label: 'HSN', visible: true, align: 'left' },
  { field: 'quantity', label: 'QTY', visible: true, align: 'center' },
  { field: 'unitPricePaise', label: 'RATE', visible: true, align: 'right' },
  { field: 'taxRateBp', label: 'GST%', visible: true, align: 'right' },
  { field: 'amountPaise', label: 'AMOUNT', visible: true, align: 'right' },
];

const SEEDED_TAX_COMPLIANT_LAYOUT_SCHEMA: LayoutBlock[] = [
  { type: 'HEADER', order: 1, props: {} },
  { type: 'MERCHANT_INFO', order: 2, props: { variant: 'tax_invoice' } },
  { type: 'ITEMS', order: 3, props: { columns: TAX_COMPLIANT_ITEMS_COLUMNS, secondaryFields: [] } },
  { type: 'TOTAL', order: 4, props: { basis: 'pre_tax' } },
  { type: 'TAX_SUMMARY', order: 5, props: { mode: 'auto' } },
  { type: 'AMOUNT_PAYABLE', order: 6, props: {} },
  { type: 'FOOTER', order: 7, props: {} },
];

// Mirrors apps/api/prisma/seed.ts's retailTemplateData.layoutSchema exactly (kept in
// sync by hand, same known gap as SEEDED_TAX_COMPLIANT_LAYOUT_SCHEMA above).
const RETAIL_ITEMS_COLUMNS: ColumnConfig[] = [
  { field: 'name', label: 'ITEM', visible: true, align: 'left' },
  { field: 'quantity', label: 'QTY', visible: true, align: 'left' },
  { field: 'unitPricePaise', label: 'RATE', visible: false, align: 'right' },
  { field: 'amountPaise', label: 'AMOUNT', visible: true, align: 'right' },
];

const SEEDED_RETAIL_LAYOUT_SCHEMA: LayoutBlock[] = [
  { type: 'HEADER', order: 1, props: {} },
  { type: 'MERCHANT_INFO', order: 2, props: {} },
  { type: 'ITEMS', order: 3, props: { columns: RETAIL_ITEMS_COLUMNS, secondaryFields: ['hsn'] } },
  { type: 'TOTAL', order: 4, props: { basis: 'pre_tax' } },
  { type: 'SAVINGS', order: 5, props: {} },
  { type: 'TAX_SUMMARY', order: 6, props: { mode: 'auto' } },
  { type: 'AMOUNT_PAYABLE', order: 7, props: {} },
  { type: 'LOYALTY', order: 8, props: {} },
  {
    type: 'COUPON',
    order: 9,
    props: { headline: 'Get 10% off your next visit', code: 'RETAIL10', validity: 'Valid for 30 days', ctaLabel: 'Show this code at checkout' },
  },
  { type: 'SURVEY', order: 10, props: { prompt: 'How was your shopping experience today?', type: 'rating', url: 'https://example.test/survey' } },
  { type: 'FOOTER', order: 11, props: {} },
];

// Mirrors apps/api/prisma/seed.ts's restaurantTemplateData.layoutSchema exactly (kept
// in sync by hand, same known gap as the other SEEDED_*_LAYOUT_SCHEMA fixtures above).
const RESTAURANT_ITEMS_COLUMNS: ColumnConfig[] = [
  { field: 'name', label: 'ITEM', visible: true, align: 'left' },
  { field: 'quantity', label: 'QTY', visible: true, align: 'left' },
  { field: 'unitPricePaise', label: 'RATE', visible: false, align: 'right' },
  { field: 'amountPaise', label: 'AMOUNT', visible: true, align: 'right' },
];

const SEEDED_RESTAURANT_LAYOUT_SCHEMA: LayoutBlock[] = [
  { type: 'HEADER', order: 1, props: {} },
  { type: 'MERCHANT_INFO', order: 2, props: {} },
  { type: 'BILL_META', order: 3, props: {} },
  { type: 'ITEMS', order: 4, props: { columns: RESTAURANT_ITEMS_COLUMNS, secondaryFields: [] } },
  { type: 'TOTAL', order: 5, props: { basis: 'pre_tax' } },
  { type: 'TAX_SUMMARY', order: 6, props: { mode: 'auto' } },
  { type: 'AMOUNT_PAYABLE', order: 7, props: {} },
  { type: 'FOOTER', order: 8, props: {} },
  {
    type: 'COUPON',
    order: 9,
    props: { headline: 'Free dessert on your next visit!', code: 'QSR-SWEET', validity: 'Valid for 30 days', ctaLabel: 'Show this at the counter' },
  },
  { type: 'SURVEY', order: 10, props: { prompt: 'How was your meal today?', type: 'rating', url: 'https://example.test/survey' } },
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
        kind: 'receipt',
        addressLine1: '221, Linking Road',
        addressLine2: 'Bandra West',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400050',
        gstin: '27ABCDE1234F1Z5',
      },
      { type: 'ITEMS', kind: 'single', totalPaise: '100', currency: 'INR' },
      { type: 'TOTAL', kind: 'simple', totalPaise: '100', currency: 'INR' },
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
      { type: 'TOTAL', kind: 'simple', totalPaise: 'Amount unavailable', currency: 'Amount unavailable' },
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

    expect(result).toEqual([{ type: 'TAX_SUMMARY', kind: 'legacy_matrix', isIntraState: true, rows: [], currency: 'INR' }]);
  });

  it('renders the seeded TAX_COMPLIANT layoutSchema (T-2) end-to-end without throwing', () => {
    const result = renderTemplate(SEEDED_TAX_COMPLIANT_LAYOUT_SCHEMA, SAMPLE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result.map((block) => block.type)).toEqual([
      'HEADER',
      'MERCHANT_INFO',
      'ITEMS',
      'TOTAL',
      'TAX_SUMMARY',
      'AMOUNT_PAYABLE',
      'FOOTER',
    ]);
  });

  // ---- BUG 1 fix: MERCHANT_INFO 'tax_invoice' kind — sourced from the frozen
  // snapshot, never the live merchant param (BR-2 immutability). ----

  it('BUG 1 fix: MERCHANT_INFO with props.variant "tax_invoice" sources seller info + invoice meta from the snapshot, not the live merchant', () => {
    const liveMerchantWithDifferentData: BillMerchant = {
      ...SAMPLE_MERCHANT,
      name: 'A DIFFERENT CURRENT NAME',
      gstin: '99ZZZZZ0000Z1Z9',
    };

    const result = renderTemplate(
      [{ type: 'MERCHANT_INFO', order: 1, props: { variant: 'tax_invoice' } }],
      TAX_INVOICE_SNAPSHOT,
      liveMerchantWithDifferentData,
    );

    expect(result).toEqual([
      {
        type: 'MERCHANT_INFO',
        kind: 'tax_invoice',
        merchantName: 'Demo Merchant', // from TAX_INVOICE_SNAPSHOT.merchantName, not the live merchant's "A DIFFERENT CURRENT NAME"
        address: undefined, // TAX_INVOICE_SNAPSHOT has no merchantAddress set in this fixture
        gstin: '27ABCDE1234F1Z5', // from TAX_INVOICE_SNAPSHOT.merchantGstin, not the live merchant's "99ZZZZZ..."
        invoiceNumber: 'INV-2026-0001',
        placeOfSupply: '27',
      },
    ]);
  });

  it('BUG 1 fix: MERCHANT_INFO without props.variant keeps the existing "receipt" behavior (other skeletons unaffected)', () => {
    const result = renderTemplate([{ type: 'MERCHANT_INFO', order: 1, props: {} }], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    const block = result[0];
    expect(block.type).toBe('MERCHANT_INFO');
    if (block.type === 'MERCHANT_INFO') expect(block.kind).toBe('receipt');
  });

  it('BUG 1 fix: TAX_COMPLIANT\'s ITEMS renders "columns" kind with its 6-column DESCRIPTION/HSN/QTY/RATE/GST%/AMOUNT config, no discount column at all', () => {
    const result = renderTemplate(
      [{ type: 'ITEMS', order: 1, props: { columns: TAX_COMPLIANT_ITEMS_COLUMNS, secondaryFields: [] } }],
      TAX_INVOICE_SNAPSHOT,
      SAMPLE_MERCHANT,
    );

    const block = result[0];
    if (block.type !== 'ITEMS' || block.kind !== 'columns') throw new Error('expected columns ITEMS');

    expect(block.columns.map((c) => c.field)).toEqual(['name', 'hsn', 'quantity', 'unitPricePaise', 'taxRateBp', 'amountPaise']);
    expect(block.columns.every((c) => c.visible)).toBe(true); // all 6 visible, unlike RETAIL's hidden RATE
    expect(block.secondaryFields).toEqual([]); // HSN is a real column here, not a muted secondary line
    expect(block.rows[0].fields.amountPaise).toBe('21000'); // 20000 taxable + 1000 tax
  });

  it('BUG 1 fix: a <script> in an item name passes through the TAX_COMPLIANT columns-driven ITEMS unmodified as plain data', () => {
    const maliciousName = '<script>alert(1)</script>';
    const snapshot: BillSnapshot = { ...TAX_INVOICE_SNAPSHOT, items: [{ ...TAX_INVOICE_ITEMS[0], name: maliciousName }] };

    const result = renderTemplate(
      [{ type: 'ITEMS', order: 1, props: { columns: TAX_COMPLIANT_ITEMS_COLUMNS, secondaryFields: [] } }],
      snapshot,
      SAMPLE_MERCHANT,
    );

    const block = result[0];
    if (block.type !== 'ITEMS' || block.kind !== 'columns') throw new Error('expected columns ITEMS');
    expect(block.rows[0].fields.name).toBe(maliciousName);
  });

  // ---- BUG 2 fix: TAX_COMPLIANT now reuses RETAIL's exact aggregate/pre_tax logic ----

  it('BUG 2 fix: TAX_COMPLIANT\'s TAX_SUMMARY now renders "aggregate", not "legacy_matrix"', () => {
    const result = renderTemplate(
      [{ type: 'TAX_SUMMARY', order: 1, props: { mode: 'auto' } }],
      TAX_INVOICE_SNAPSHOT,
      SAMPLE_MERCHANT,
    );

    const block = result[0];
    expect(block.type).toBe('TAX_SUMMARY');
    if (block.type === 'TAX_SUMMARY') expect(block.kind).toBe('aggregate');
  });

  it('BUG 2 fix: TAX_COMPLIANT\'s TOTAL now shows the pre-tax figure, matching RETAIL', () => {
    const result = renderTemplate([{ type: 'TOTAL', order: 1, props: { basis: 'pre_tax' } }], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([{ type: 'TOTAL', kind: 'pre_tax', totalPaise: '25000', currency: 'INR' }]);
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
        kind: 'legacy_matrix',
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
        kind: 'legacy_matrix',
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
        kind: 'legacy_matrix',
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

  // ==================== RETAIL template ====================

  it('RETAIL: renders the full seeded layoutSchema end-to-end without throwing, in order', () => {
    const result = renderTemplate(SEEDED_RETAIL_LAYOUT_SCHEMA, TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result.map((block) => block.type)).toEqual([
      'HEADER',
      'MERCHANT_INFO',
      'ITEMS',
      'TOTAL',
      'SAVINGS',
      'TAX_SUMMARY',
      'AMOUNT_PAYABLE',
      'LOYALTY',
      'COUPON',
      'SURVEY',
      'FOOTER',
    ]);
  });

  it('RETAIL: columns-driven ITEMS reads field/label/visible/align from props.columns, computing amountPaise = taxable+tax', () => {
    const block: LayoutBlock = { type: 'ITEMS', order: 1, props: { columns: RETAIL_ITEMS_COLUMNS, secondaryFields: ['hsn'] } };
    const result = renderTemplate([block], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([
      {
        type: 'ITEMS',
        kind: 'columns',
        columns: RETAIL_ITEMS_COLUMNS,
        secondaryFields: ['hsn'],
        currency: 'INR',
        rows: [
          {
            lineNo: 1,
            fields: {
              name: 'Wireless Mouse',
              hsn: '8471',
              uom: 'NOS',
              quantity: 2,
              unitPricePaise: '10000',
              discountPaise: '0',
              taxRateBp: 500,
              taxableValuePaise: '20000',
              taxPaise: '1000',
              amountPaise: '21000', // 20000 + 1000
            },
          },
          {
            lineNo: 2,
            fields: {
              name: 'USB-C Cable',
              hsn: '8544',
              uom: 'NOS',
              quantity: 1,
              unitPricePaise: '5000',
              discountPaise: '0',
              taxRateBp: 1800,
              taxableValuePaise: '5000',
              taxPaise: '900',
              amountPaise: '5900', // 5000 + 900
            },
          },
        ],
      },
    ]);
  });

  it('RETAIL: falls back to the "columns" kind only when props.columns is present — plain ITEMS blocks are unaffected', () => {
    const result = renderTemplate([{ type: 'ITEMS', order: 1, props: {} }], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    const block = result[0];
    expect(block.type).toBe('ITEMS');
    if (block.type === 'ITEMS') expect(block.kind).toBe('itemized'); // TAX_COMPLIANT's existing path, untouched
  });

  it('RETAIL: TOTAL with props.basis "pre_tax" shows subtotal - discount, not the grand total', () => {
    const result = renderTemplate([{ type: 'TOTAL', order: 1, props: { basis: 'pre_tax' } }], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([{ type: 'TOTAL', kind: 'pre_tax', totalPaise: '25000', currency: 'INR' }]); // 25000 - 0
  });

  it('RETAIL: TOTAL without props.basis keeps the existing grand-total behavior (other skeletons unaffected)', () => {
    const result = renderTemplate([{ type: 'TOTAL', order: 1, props: {} }], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([{ type: 'TOTAL', kind: 'simple', totalPaise: 'Amount unavailable', currency: 'INR' }]);
  });

  it('RETAIL: AMOUNT_PAYABLE shows the grand total (distinct from pre-tax TOTAL)', () => {
    const snapshot: BillSnapshot = { ...TAX_INVOICE_SNAPSHOT, amountPaise: '26900' };
    const result = renderTemplate([{ type: 'AMOUNT_PAYABLE', order: 1, props: {} }], snapshot, SAMPLE_MERCHANT);

    expect(result).toEqual([{ type: 'AMOUNT_PAYABLE', totalPaise: '26900', currency: 'INR' }]);
  });

  // ---- RETAIL: TAX_SUMMARY aggregate shape (§5, final spec) ----
  // ONE structure always: Taxable Amount, one CGST row, one SGST row (or one IGST row
  // inter-state), Total Tax — summed across ALL tax rates, no per-rate breakdown, no
  // rate percentages, regardless of how many distinct rates are on the bill. This
  // replaces the earlier 'component_rows' simple/detailed pair entirely.

  it('RETAIL: TAX_SUMMARY aggregates a single tax slab, intra-state — one CGST row, one SGST row, no rate shown', () => {
    const snapshot: BillSnapshot = {
      ...TAX_INVOICE_SNAPSHOT,
      cgstPaise: '500',
      sgstPaise: '500',
      igstPaise: '0',
      items: [TAX_INVOICE_ITEMS[0]], // single 500bp slab only
    };

    const result = renderTemplate([{ type: 'TAX_SUMMARY', order: 1, props: { mode: 'auto' } }], snapshot, SAMPLE_MERCHANT);

    expect(result).toEqual([
      {
        type: 'TAX_SUMMARY',
        kind: 'aggregate',
        isIntraState: true,
        taxableValuePaise: '20000',
        cgstPaise: '500',
        sgstPaise: '500',
        igstPaise: '0',
        totalTaxPaise: '1000',
        currency: 'INR',
      },
    ]);
  });

  it('RETAIL: TAX_SUMMARY aggregates a single tax slab, inter-state — one IGST row, no CGST/SGST', () => {
    const singleSlabItem: BillSnapshotLineItem = { ...TAX_INVOICE_ITEMS[0], cgstPaise: '0', sgstPaise: '0', igstPaise: '1000' };
    const snapshot: BillSnapshot = {
      ...TAX_INVOICE_SNAPSHOT,
      cgstPaise: '0',
      sgstPaise: '0',
      igstPaise: '1000',
      items: [singleSlabItem],
    };

    const result = renderTemplate([{ type: 'TAX_SUMMARY', order: 1, props: { mode: 'auto' } }], snapshot, SAMPLE_MERCHANT);

    expect(result).toEqual([
      {
        type: 'TAX_SUMMARY',
        kind: 'aggregate',
        isIntraState: false,
        taxableValuePaise: '20000',
        cgstPaise: '0',
        sgstPaise: '0',
        igstPaise: '1000',
        totalTaxPaise: '1000',
        currency: 'INR',
      },
    ]);
  });

  it('RETAIL: TAX_SUMMARY with MULTIPLE tax slabs still produces exactly ONE CGST value and ONE SGST value, summed across all rates — no per-rate breakdown', () => {
    // TAX_INVOICE_SNAPSHOT has two distinct rates (500bp, 1800bp) — this is exactly the
    // case that used to trigger 'detailed' mode's 4-row table. It must not anymore.
    const result = renderTemplate([{ type: 'TAX_SUMMARY', order: 1, props: { mode: 'auto' } }], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([
      {
        type: 'TAX_SUMMARY',
        kind: 'aggregate',
        isIntraState: true,
        taxableValuePaise: '25000', // 20000 + 5000, summed across both slabs
        cgstPaise: '950', // 500 + 450, summed across both slabs — NOT two separate rows
        sgstPaise: '950', // 500 + 450
        igstPaise: '0',
        totalTaxPaise: '1900', // 950 + 950
        currency: 'INR',
      },
    ]);
  });

  it('RETAIL: TAX_SUMMARY with multiple tax slabs, inter-state, produces exactly ONE IGST value summed across all rates', () => {
    const result = renderTemplate(
      [{ type: 'TAX_SUMMARY', order: 1, props: { mode: 'auto' } }],
      INTER_STATE_TAX_INVOICE_SNAPSHOT,
      SAMPLE_MERCHANT,
    );

    expect(result).toEqual([
      {
        type: 'TAX_SUMMARY',
        kind: 'aggregate',
        isIntraState: false,
        taxableValuePaise: '25000',
        cgstPaise: '0',
        sgstPaise: '0',
        igstPaise: '1900', // 1000 + 900, summed across both slabs
        totalTaxPaise: '1900',
        currency: 'INR',
      },
    ]);
  });

  it('RETAIL: TAX_SUMMARY Total Tax is computed as cgstPaise + sgstPaise (BigInt), never independently re-derived', () => {
    const result = renderTemplate([{ type: 'TAX_SUMMARY', order: 1, props: { mode: 'auto' } }], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    const block = result[0];
    if (block.type !== 'TAX_SUMMARY' || block.kind !== 'aggregate') throw new Error('expected aggregate TAX_SUMMARY');

    expect(block.totalTaxPaise).toBe((BigInt(block.cgstPaise) + BigInt(block.sgstPaise)).toString());
  });

  it('RETAIL: TAX_SUMMARY without an explicit props.mode keeps the existing legacy_matrix behavior (TAX_COMPLIANT unaffected)', () => {
    const result = renderTemplate([{ type: 'TAX_SUMMARY', order: 1, props: {} }], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    const block = result[0];
    expect(block.type).toBe('TAX_SUMMARY');
    if (block.type === 'TAX_SUMMARY') expect(block.kind).toBe('legacy_matrix');
  });

  // ---- RETAIL: SAVINGS/LOYALTY — no data source yet, never fabricated ----

  it('RETAIL: SAVINGS has no data source yet — savingsPaise is always undefined', () => {
    const result = renderTemplate([{ type: 'SAVINGS', order: 1, props: {} }], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([{ type: 'SAVINGS', savingsPaise: undefined, currency: 'INR' }]);
  });

  it('RETAIL: LOYALTY has no data source yet — pointsEarned/balance are always undefined', () => {
    const result = renderTemplate([{ type: 'LOYALTY', order: 1, props: {} }], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([{ type: 'LOYALTY', pointsEarned: undefined, balance: undefined }]);
  });

  // ---- RETAIL: COUPON/SURVEY — template-authored static copy, CAN render real
  // content today (unlike SAVINGS/LOYALTY, which need bill-computed data). ----

  it('RETAIL: COUPON renders real template-authored props, no bill-data dependency', () => {
    const block: LayoutBlock = {
      type: 'COUPON',
      order: 1,
      props: { headline: '10% off your next visit', code: 'RETAIL10', validity: 'Valid till 31 Aug', ctaLabel: 'Redeem' },
    };
    const result = renderTemplate([block], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([
      { type: 'COUPON', headline: '10% off your next visit', code: 'RETAIL10', validity: 'Valid till 31 Aug', ctaLabel: 'Redeem' },
    ]);
  });

  it('RETAIL: SURVEY renders real template-authored props', () => {
    const block: LayoutBlock = { type: 'SURVEY', order: 1, props: { prompt: 'How was your visit?', type: 'rating', url: 'https://example.test/survey' } };
    const result = renderTemplate([block], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([{ type: 'SURVEY', prompt: 'How was your visit?', surveyType: 'rating', url: 'https://example.test/survey' }]);
  });

  // ---- RETAIL: item name safety in the columns-driven path ----

  it('RETAIL: a <script> in an item name passes through the columns-driven ITEMS unmodified as plain data', () => {
    const maliciousName = '<script>alert(1)</script>';
    const snapshot: BillSnapshot = { ...TAX_INVOICE_SNAPSHOT, items: [{ ...TAX_INVOICE_ITEMS[0], name: maliciousName }] };
    const block: LayoutBlock = { type: 'ITEMS', order: 1, props: { columns: RETAIL_ITEMS_COLUMNS, secondaryFields: ['hsn'] } };

    const result = renderTemplate([block], snapshot, SAMPLE_MERCHANT);

    const itemsBlock = result[0];
    if (itemsBlock.type !== 'ITEMS' || itemsBlock.kind !== 'columns') throw new Error('expected columns ITEMS');
    expect(itemsBlock.rows[0].fields.name).toBe(maliciousName);
  });

  // ==================== RESTAURANT/QSR template ====================
  // Reuses RETAIL's architecture directly — same 'columns' ITEMS, 'pre_tax' TOTAL,
  // 'aggregate' TAX_SUMMARY, AMOUNT_PAYABLE, COUPON/SURVEY rendering. Only new: the
  // BILL_META block type and this seed config (no quantity-as-separate-column, no HSN
  // at all, no SAVINGS/LOYALTY).

  it('RESTAURANT: renders the full seeded layoutSchema end-to-end without throwing, in order', () => {
    const result = renderTemplate(SEEDED_RESTAURANT_LAYOUT_SCHEMA, TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result.map((block) => block.type)).toEqual([
      'HEADER',
      'MERCHANT_INFO',
      'BILL_META',
      'ITEMS',
      'TOTAL',
      'TAX_SUMMARY',
      'AMOUNT_PAYABLE',
      'FOOTER',
      'COUPON',
      'SURVEY',
    ]);
  });

  it('RESTAURANT: BILL_META renders billNumber from snapshot.invoiceNumber; date is always undefined (no data source yet)', () => {
    const result = renderTemplate([{ type: 'BILL_META', order: 1, props: {} }], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([{ type: 'BILL_META', billNumber: 'INV-2026-0001', date: undefined }]);
  });

  it('RESTAURANT: BILL_META with no invoiceNumber on the snapshot still doesn\'t throw', () => {
    const snapshot: BillSnapshot = { ...TAX_INVOICE_SNAPSHOT, invoiceNumber: undefined };
    const result = renderTemplate([{ type: 'BILL_META', order: 1, props: {} }], snapshot, SAMPLE_MERCHANT);

    expect(result).toEqual([{ type: 'BILL_META', billNumber: undefined, date: undefined }]);
  });

  it('RESTAURANT: ITEMS config has no hsn field anywhere (not a column, not a secondaryField) and quantity is present for the name-fold', () => {
    const result = renderTemplate(
      [{ type: 'ITEMS', order: 1, props: { columns: RESTAURANT_ITEMS_COLUMNS, secondaryFields: [] } }],
      TAX_INVOICE_SNAPSHOT,
      SAMPLE_MERCHANT,
    );

    const block = result[0];
    if (block.type !== 'ITEMS' || block.kind !== 'columns') throw new Error('expected columns ITEMS');

    expect(block.columns.some((c) => c.field === 'hsn')).toBe(false);
    expect(block.secondaryFields).toEqual([]);
    expect(block.columns.find((c) => c.field === 'quantity')).toBeDefined();
    // The row data still carries hsn (computed generically for every columns-driven
    // ITEMS block) — it's the CONFIG that excludes it from ever being displayed.
    expect(block.rows[0].fields.hsn).toBe('8471');
  });

  it('RESTAURANT: TAX_SUMMARY reuses the exact same aggregate structure as RETAIL — no reimplementation', () => {
    const result = renderTemplate([{ type: 'TAX_SUMMARY', order: 1, props: { mode: 'auto' } }], TAX_INVOICE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([
      {
        type: 'TAX_SUMMARY',
        kind: 'aggregate',
        isIntraState: true,
        taxableValuePaise: '25000',
        cgstPaise: '950',
        sgstPaise: '950',
        igstPaise: '0',
        totalTaxPaise: '1900',
        currency: 'INR',
      },
    ]);
  });

  it('RESTAURANT: a <script> in an item name passes through the columns-driven ITEMS unmodified as plain data', () => {
    const maliciousName = '<script>alert(1)</script>';
    const snapshot: BillSnapshot = { ...TAX_INVOICE_SNAPSHOT, items: [{ ...TAX_INVOICE_ITEMS[0], name: maliciousName }] };
    const block: LayoutBlock = { type: 'ITEMS', order: 1, props: { columns: RESTAURANT_ITEMS_COLUMNS, secondaryFields: [] } };

    const result = renderTemplate([block], snapshot, SAMPLE_MERCHANT);

    const itemsBlock = result[0];
    if (itemsBlock.type !== 'ITEMS' || itemsBlock.kind !== 'columns') throw new Error('expected columns ITEMS');
    expect(itemsBlock.rows[0].fields.name).toBe(maliciousName);
  });
});
