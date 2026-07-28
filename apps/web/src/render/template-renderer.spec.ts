import { renderTemplate, LayoutBlock, BillSnapshot, BillMerchant } from './template-renderer';

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
      { type: 'ITEMS', totalPaise: '100', currency: 'INR' },
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
      { type: 'ITEMS', totalPaise: 'Amount unavailable', currency: 'Amount unavailable' },
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

  it('renders TAX_SUMMARY as a recognized, content-less block without throwing (T-2; real content is V-5)', () => {
    const result = renderTemplate([{ type: 'TAX_SUMMARY', order: 1, props: {} }], SAMPLE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result).toEqual([{ type: 'TAX_SUMMARY' }]);
  });

  it('renders the seeded TAX_COMPLIANT layoutSchema (T-2) end-to-end without throwing', () => {
    const result = renderTemplate(SEEDED_TAX_COMPLIANT_LAYOUT_SCHEMA, SAMPLE_SNAPSHOT, SAMPLE_MERCHANT);

    expect(result.map((block) => block.type)).toEqual(['HEADER', 'MERCHANT_INFO', 'ITEMS', 'TAX_SUMMARY', 'TOTAL', 'FOOTER']);
  });
});
