import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalizeToV2, LayoutBlockV1 } from '@digital-billing/block-manifest';
import { renderTemplate, BillSnapshot, BillMerchant, LayoutBlock } from './template-renderer';
import { BillBlocks } from './BillBlocks';

// T-4's named golden test: the seeded RETAIL template renders byte-identical
// HTML before and after normalization. Mirrors apps/api/prisma/seed.ts's
// retailTemplateData.layoutSchema exactly (same hand-sync convention already
// used by template-renderer.spec.ts).
const RETAIL_ITEMS_COLUMNS = [
  { field: 'name', label: 'ITEM', visible: true, align: 'left' as const },
  { field: 'quantity', label: 'QTY', visible: true, align: 'left' as const },
  { field: 'unitPricePaise', label: 'RATE', visible: false, align: 'right' as const },
  { field: 'amountPaise', label: 'AMOUNT', visible: true, align: 'right' as const },
];

const SEEDED_RETAIL_V1: LayoutBlockV1[] = [
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
  { type: 'QR_CODE', order: 11, props: { path: '/offer/RETAIL10', caption: 'Scan for an exclusive offer' } },
  { type: 'FOOTER', order: 12, props: {} },
];

const SNAPSHOT: BillSnapshot = {
  merchantName: 'Demo Merchant',
  amountPaise: '123456',
  currency: 'INR',
  receiptNumber: 'r-1',
  paymentDateTime: '20260101120000',
  subtotalPaise: '123456',
  discountPaise: '0',
  items: [
    {
      lineNo: 1,
      name: 'Widget',
      hsn: '1234',
      uom: 'PCS',
      quantity: 2,
      unitPricePaise: '61728',
      itemDiscountPaise: '0',
      billDiscountAllocPaise: '0',
      taxRateBp: 1800,
      taxableValuePaise: '123456',
      taxPaise: '22222',
      cgstPaise: '11111',
      sgstPaise: '11111',
      igstPaise: '0',
    },
  ],
};
const MERCHANT: BillMerchant = { name: 'Demo Merchant', addressLine1: '221, Linking Road', city: 'Mumbai', gstin: '27ABCDE1234F1Z5' };

function renderHtml(blocks: LayoutBlock[]): string {
  const rendered = renderTemplate(blocks, SNAPSHOT, MERCHANT);
  return renderToStaticMarkup(React.createElement(BillBlocks, { blocks: rendered, skeleton: 'RETAIL' }));
}

describe('normalizeToV2 golden test — RETAIL renders byte-identical before/after normalization', () => {
  it('produces identical HTML for the raw v1 array and its normalized v2 blocks', () => {
    const beforeHtml = renderHtml(SEEDED_RETAIL_V1);

    const v2 = normalizeToV2(SEEDED_RETAIL_V1, 'RETAIL');
    // renderTemplate's LayoutBlock only reads type/order/props — the v2
    // blocks carry extra id/visible/width fields, which is exactly what this
    // test is proving doesn't change the output.
    const afterHtml = renderHtml(v2.blocks);

    expect(afterHtml).toBe(beforeHtml);
    expect(beforeHtml.length).toBeGreaterThan(0);
  });
});
