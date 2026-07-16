import { renderTemplate, LayoutBlock, BillSnapshot } from './template-renderer';

// Mirrors apps/api/prisma/seed.ts's seeded receipt template layoutSchema.
const SEEDED_LAYOUT_SCHEMA: LayoutBlock[] = [
  { type: 'HEADER', order: 1, props: {} },
  { type: 'MERCHANT_INFO', order: 2, props: {} },
  { type: 'ITEMS', order: 3, props: {} },
  { type: 'TOTAL', order: 4, props: {} },
  { type: 'FOOTER', order: 5, props: {} },
];

// Mirrors the snapshot shape apps/api/src/callbacks/callbacks.service.ts (P-1) writes.
const SAMPLE_SNAPSHOT: BillSnapshot = {
  merchantName: 'Demo Merchant',
  amountPaise: '100',
  currency: 'INR',
  paymentMode: 'Card',
  paymentDateTime: '20250910123438',
};

describe('renderTemplate', () => {
  it('produces expected blocks in order for a seeded template + sample snapshot', () => {
    const result = renderTemplate(SEEDED_LAYOUT_SCHEMA, SAMPLE_SNAPSHOT);

    expect(result).toEqual([
      { type: 'HEADER', merchantName: 'Demo Merchant' },
      { type: 'MERCHANT_INFO', merchantName: 'Demo Merchant' },
      { type: 'ITEMS', totalPaise: '100', currency: 'INR' },
      { type: 'TOTAL', totalPaise: '100', currency: 'INR' },
      { type: 'FOOTER', paymentMode: 'Card', paymentDateTime: '20250910123438' },
    ]);
  });

  it('renders blocks in layoutSchema order regardless of array order', () => {
    const shuffled: LayoutBlock[] = [
      { type: 'FOOTER', order: 5, props: {} },
      { type: 'HEADER', order: 1, props: {} },
      { type: 'TOTAL', order: 4, props: {} },
      { type: 'ITEMS', order: 3, props: {} },
      { type: 'MERCHANT_INFO', order: 2, props: {} },
    ];

    const result = renderTemplate(shuffled, SAMPLE_SNAPSHOT);

    expect(result.map((block) => block.type)).toEqual(['HEADER', 'MERCHANT_INFO', 'ITEMS', 'TOTAL', 'FOOTER']);
  });

  it('renders blank/undefined values for non-money fields missing from snapshot, without throwing', () => {
    const result = renderTemplate([{ type: 'HEADER', order: 1, props: {} }], {});

    expect(result).toEqual([{ type: 'HEADER', merchantName: undefined }]);
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

  it('guards unknown block types by throwing (D-10)', () => {
    const invalidSchema = [{ type: 'BOGUS', order: 1, props: {} }] as LayoutBlock[];

    expect(() => renderTemplate(invalidSchema, SAMPLE_SNAPSHOT)).toThrow(/Unknown block type/);
  });
});
