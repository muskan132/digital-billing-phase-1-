// NOTE: fixture data below is hand-copied from preview-fixtures.ts's computed output (not regenerated via computeInvoice, per D-30) and can drift if that file changes without this one being updated to match — same accepted risk as normalize-layout-parity.spec.ts's hand-mirrored layoutSchema.
//
// X-1 (D-34): the guarantee is this test, not the architecture. Imports and
// calls renderPreviewBill (exported from preview-frame/page.tsx) and
// renderProductionBill (exported from [identifier]/page.tsx) directly — the
// EXACT functions each real page uses, not a spec-local reimplementation of
// their logic. That distinction matters: a reimplementation can't fail when
// only the real page's wiring changes, so it can't actually catch the
// regression D-34 exists to guard against. Verified by deliberately editing
// each real page's wiring by one character and confirming this test goes red
// (see the PR/commit history for the red/green transcript).
//
// SEEDED_TEMPLATES below hand-mirrors apps/api/prisma/seed.ts's five
// layoutSchema arrays; FIXTURES hand-mirrors apps/api/src/fixtures/
// preview-fixtures.ts's five computed FixtureSnapshot literals (values only,
// not the computeInvoice generation logic — apps/web has no reach into
// apps/api's source, per D-30). Both are the same hand-sync convention
// already used by normalize-layout-parity.spec.ts's SEEDED_RETAIL_V1: if
// either source file changes, this file must be updated to match by hand —
// nothing enforces the sync automatically.
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { normalizeToV2, LayoutBlockV1 } from '@digital-billing/block-manifest';
import { BillSnapshot, BillSnapshotLineItem, BillMerchant } from './template-renderer';
import { BillBlocks } from './BillBlocks';
import { renderPreviewBill } from '../../app/(preview)/demo/templates/preview-frame/page';
import { renderProductionBill, BillLayoutSnapshot } from '../../app/(main)/[identifier]/page';

// --- SEEDED_TEMPLATES: apps/api/prisma/seed.ts, byte-for-byte -------------

const RECEIPT_LAYOUT_SCHEMA: LayoutBlockV1[] = [
  { type: 'HEADER', order: 1, props: {} },
  { type: 'MERCHANT_INFO', order: 2, props: {} },
  { type: 'ITEMS', order: 3, props: {} },
  { type: 'TOTAL', order: 4, props: {} },
  { type: 'PAYMENT_DETAILS', order: 5, props: {} },
  { type: 'FOOTER', order: 6, props: {} },
];

const SEEDED_TEMPLATES: { name: string; skeleton: string; layoutSchema: LayoutBlockV1[] }[] = [
  { name: 'MINIMALIST', skeleton: 'MINIMALIST', layoutSchema: RECEIPT_LAYOUT_SCHEMA },
  { name: 'COMPACT_THERMAL', skeleton: 'COMPACT_THERMAL', layoutSchema: RECEIPT_LAYOUT_SCHEMA },
  {
    name: 'TAX_COMPLIANT',
    skeleton: 'TAX_COMPLIANT',
    layoutSchema: [
      { type: 'HEADER', order: 1, props: {} },
      { type: 'MERCHANT_INFO', order: 2, props: { variant: 'tax_invoice' } },
      {
        type: 'ITEMS',
        order: 3,
        props: {
          columns: [
            { field: 'name', label: 'DESCRIPTION', visible: true, align: 'left' },
            { field: 'hsn', label: 'HSN', visible: true, align: 'left' },
            { field: 'quantity', label: 'QTY', visible: true, align: 'center' },
            { field: 'unitPricePaise', label: 'RATE', visible: true, align: 'right' },
            { field: 'taxRateBp', label: 'GST%', visible: true, align: 'right' },
            { field: 'amountPaise', label: 'AMOUNT', visible: true, align: 'right' },
          ],
          secondaryFields: [],
        },
      },
      { type: 'TOTAL', order: 4, props: { basis: 'pre_tax' } },
      { type: 'TAX_SUMMARY', order: 5, props: { mode: 'auto' } },
      { type: 'AMOUNT_PAYABLE', order: 6, props: {} },
      { type: 'FOOTER', order: 7, props: {} },
    ],
  },
  {
    name: 'RETAIL',
    skeleton: 'RETAIL',
    layoutSchema: [
      { type: 'HEADER', order: 1, props: {} },
      { type: 'MERCHANT_INFO', order: 2, props: {} },
      {
        type: 'ITEMS',
        order: 3,
        props: {
          columns: [
            { field: 'name', label: 'ITEM', visible: true, align: 'left' },
            { field: 'quantity', label: 'QTY', visible: true, align: 'left' },
            { field: 'unitPricePaise', label: 'RATE', visible: false, align: 'right' },
            { field: 'amountPaise', label: 'AMOUNT', visible: true, align: 'right' },
          ],
          secondaryFields: ['hsn'],
        },
      },
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
    ],
  },
  {
    name: 'RESTAURANT',
    skeleton: 'RESTAURANT',
    layoutSchema: [
      { type: 'HEADER', order: 1, props: {} },
      { type: 'MERCHANT_INFO', order: 2, props: {} },
      { type: 'BILL_META', order: 3, props: {} },
      {
        type: 'ITEMS',
        order: 4,
        props: {
          columns: [
            { field: 'name', label: 'ITEM', visible: true, align: 'left' },
            { field: 'quantity', label: 'QTY', visible: true, align: 'left' },
            { field: 'unitPricePaise', label: 'RATE', visible: false, align: 'right' },
            { field: 'amountPaise', label: 'AMOUNT', visible: true, align: 'right' },
          ],
          secondaryFields: [],
        },
      },
      { type: 'TOTAL', order: 5, props: { basis: 'pre_tax' } },
      { type: 'TAX_SUMMARY', order: 6, props: { mode: 'auto' } },
      { type: 'AMOUNT_PAYABLE', order: 7, props: {} },
      { type: 'FOOTER', order: 8, props: {} },
      { type: 'SURVEY', order: 9, props: { prompt: 'How was your meal today?', type: 'rating', url: 'https://example.test/survey' } },
      {
        type: 'COUPON',
        order: 10,
        props: { headline: 'Free dessert on your next visit!', code: 'QSR-SWEET', validity: 'Valid for 30 days', ctaLabel: 'Show this at the counter' },
      },
    ],
  },
];

// --- FIXTURES: apps/api/src/fixtures/preview-fixtures.ts, computed values only ---

const FIXTURE_MERCHANT = {
  name: 'Fixture Preview Traders',
  gstin: '27AAAAA0000A1Z5',
  state: 'Maharashtra',
  address: 'Fixture Lane, Preview Nagar, 000001',
} as const;

function item(overrides: Partial<BillSnapshotLineItem>): BillSnapshotLineItem {
  const base: BillSnapshotLineItem = {
    lineNo: 1,
    name: '',
    hsn: '1234',
    uom: 'NOS',
    quantity: 1,
    unitPricePaise: '0',
    itemDiscountPaise: '0',
    billDiscountAllocPaise: '0',
    taxRateBp: 0,
    taxableValuePaise: '0',
    taxPaise: '0',
    cgstPaise: '0',
    sgstPaise: '0',
    igstPaise: '0',
  };
  return { ...base, ...overrides };
}

const FIXTURES: Record<string, BillSnapshot> = {
  TYPICAL: {
    merchantName: FIXTURE_MERCHANT.name,
    currency: 'INR',
    amountPaise: '305250',
    invoiceNumber: 'FIXTURE-TYPICAL',
    placeOfSupply: '27',
    merchantGstin: FIXTURE_MERCHANT.gstin,
    merchantState: FIXTURE_MERCHANT.state,
    merchantAddress: FIXTURE_MERCHANT.address,
    subtotalPaise: '270000',
    discountPaise: '0',
    taxPaise: '35250',
    cgstPaise: '17625',
    sgstPaise: '17625',
    igstPaise: '0',
    items: [
      item({ lineNo: 1, name: 'Preview Widget', hsn: '1234', quantity: 2, unitPricePaise: '50000', taxRateBp: 1800, taxableValuePaise: '100000', taxPaise: '18000', cgstPaise: '9000', sgstPaise: '9000' }),
      item({ lineNo: 2, name: 'Preview Gadget', hsn: '5678', quantity: 1, unitPricePaise: '125000', taxRateBp: 1200, taxableValuePaise: '125000', taxPaise: '15000', cgstPaise: '7500', sgstPaise: '7500' }),
      item({ lineNo: 3, name: 'Preview Accessory', hsn: '9012', quantity: 3, unitPricePaise: '15000', taxRateBp: 500, taxableValuePaise: '45000', taxPaise: '2250', cgstPaise: '1125', sgstPaise: '1125' }),
    ],
  },
  ZERO_RATED: {
    merchantName: FIXTURE_MERCHANT.name,
    currency: 'INR',
    amountPaise: '70000',
    invoiceNumber: 'FIXTURE-ZERO-RATED',
    placeOfSupply: '27',
    merchantGstin: FIXTURE_MERCHANT.gstin,
    merchantState: FIXTURE_MERCHANT.state,
    merchantAddress: FIXTURE_MERCHANT.address,
    subtotalPaise: '70000',
    discountPaise: '0',
    taxPaise: '0',
    cgstPaise: '0',
    sgstPaise: '0',
    igstPaise: '0',
    items: [
      item({ lineNo: 1, name: 'Preview Zero-Rated Item A', hsn: '1111', quantity: 2, unitPricePaise: '30000', taxRateBp: 0, taxableValuePaise: '60000' }),
      item({ lineNo: 2, name: 'Preview Zero-Rated Item B', hsn: '2222', quantity: 1, unitPricePaise: '10000', taxRateBp: 0, taxableValuePaise: '10000' }),
    ],
  },
  INTER_STATE_IGST: {
    merchantName: FIXTURE_MERCHANT.name,
    currency: 'INR',
    amountPaise: '392000',
    invoiceNumber: 'FIXTURE-INTERSTATE',
    placeOfSupply: '29',
    merchantGstin: FIXTURE_MERCHANT.gstin,
    merchantState: FIXTURE_MERCHANT.state,
    merchantAddress: FIXTURE_MERCHANT.address,
    subtotalPaise: '320000',
    discountPaise: '0',
    taxPaise: '72000',
    cgstPaise: '0',
    sgstPaise: '0',
    igstPaise: '72000',
    items: [
      item({ lineNo: 1, name: 'Preview Export Item', hsn: '4321', quantity: 4, unitPricePaise: '75000', taxRateBp: 1800, taxableValuePaise: '300000', taxPaise: '54000', igstPaise: '54000' }),
      item({ lineNo: 2, name: 'Preview Freight Item', hsn: '8765', quantity: 1, unitPricePaise: '20000', taxRateBp: 1200, taxableValuePaise: '20000', taxPaise: '2400', igstPaise: '2400' }),
    ],
  },
  MINIMAL: {
    merchantName: FIXTURE_MERCHANT.name,
    currency: 'INR',
    amountPaise: '105',
    invoiceNumber: 'FIXTURE-MINIMAL',
    placeOfSupply: '27',
    merchantGstin: FIXTURE_MERCHANT.gstin,
    merchantState: FIXTURE_MERCHANT.state,
    merchantAddress: FIXTURE_MERCHANT.address,
    subtotalPaise: '100',
    discountPaise: '0',
    taxPaise: '5',
    cgstPaise: '3',
    sgstPaise: '2',
    igstPaise: '0',
    items: [item({ lineNo: 1, name: 'Preview Single Item', hsn: '0001', quantity: 1, unitPricePaise: '100', taxRateBp: 500, taxableValuePaise: '100', taxPaise: '5', cgstPaise: '3', sgstPaise: '2' })],
  },
  // 40 deterministic lines cycling through 0/5/12/18/28% slabs, mirroring
  // preview-fixtures.ts's build40Lines()+computeInvoice exactly (literal
  // values, generated once from the real computeInvoice output and pasted
  // here — not re-derived by an approximate rounding rule of this file's
  // own, which would risk disagreeing with D-24's actual half-up/
  // split-by-subtraction logic on some lines).
  LONG_40_LINES: {
    merchantName: FIXTURE_MERCHANT.name,
    currency: 'INR',
    amountPaise: '1796827',
    invoiceNumber: 'FIXTURE-LONG-40',
    placeOfSupply: '27',
    merchantGstin: FIXTURE_MERCHANT.gstin,
    merchantState: FIXTURE_MERCHANT.state,
    merchantAddress: FIXTURE_MERCHANT.address,
    subtotalPaise: '1531540',
    discountPaise: '0',
    taxPaise: '265287',
    cgstPaise: '132651',
    sgstPaise: '132636',
    igstPaise: '0',
    items: [
      item({ lineNo: 1, name: 'Preview Item 1', hsn: '1234', quantity: 1, unitPricePaise: '10000', taxRateBp: 0, taxableValuePaise: '10000', taxPaise: '0', cgstPaise: '0', sgstPaise: '0' }),
      item({ lineNo: 2, name: 'Preview Item 2', hsn: '1234', quantity: 2, unitPricePaise: '10137', taxRateBp: 500, taxableValuePaise: '20274', taxPaise: '1014', cgstPaise: '507', sgstPaise: '507' }),
      item({ lineNo: 3, name: 'Preview Item 3', hsn: '1234', quantity: 3, unitPricePaise: '10274', taxRateBp: 1200, taxableValuePaise: '30822', taxPaise: '3699', cgstPaise: '1850', sgstPaise: '1849' }),
      item({ lineNo: 4, name: 'Preview Item 4', hsn: '1234', quantity: 4, unitPricePaise: '10411', taxRateBp: 1800, taxableValuePaise: '41644', taxPaise: '7496', cgstPaise: '3748', sgstPaise: '3748' }),
      item({ lineNo: 5, name: 'Preview Item 5', hsn: '1234', quantity: 5, unitPricePaise: '10548', taxRateBp: 2800, taxableValuePaise: '52740', taxPaise: '14767', cgstPaise: '7384', sgstPaise: '7383' }),
      item({ lineNo: 6, name: 'Preview Item 6', hsn: '1234', quantity: 1, unitPricePaise: '10685', taxRateBp: 0, taxableValuePaise: '10685', taxPaise: '0', cgstPaise: '0', sgstPaise: '0' }),
      item({ lineNo: 7, name: 'Preview Item 7', hsn: '1234', quantity: 2, unitPricePaise: '10822', taxRateBp: 500, taxableValuePaise: '21644', taxPaise: '1082', cgstPaise: '541', sgstPaise: '541' }),
      item({ lineNo: 8, name: 'Preview Item 8', hsn: '1234', quantity: 3, unitPricePaise: '10959', taxRateBp: 1200, taxableValuePaise: '32877', taxPaise: '3945', cgstPaise: '1973', sgstPaise: '1972' }),
      item({ lineNo: 9, name: 'Preview Item 9', hsn: '1234', quantity: 4, unitPricePaise: '11096', taxRateBp: 1800, taxableValuePaise: '44384', taxPaise: '7989', cgstPaise: '3995', sgstPaise: '3994' }),
      item({ lineNo: 10, name: 'Preview Item 10', hsn: '1234', quantity: 5, unitPricePaise: '11233', taxRateBp: 2800, taxableValuePaise: '56165', taxPaise: '15726', cgstPaise: '7863', sgstPaise: '7863' }),
      item({ lineNo: 11, name: 'Preview Item 11', hsn: '1234', quantity: 1, unitPricePaise: '11370', taxRateBp: 0, taxableValuePaise: '11370', taxPaise: '0', cgstPaise: '0', sgstPaise: '0' }),
      item({ lineNo: 12, name: 'Preview Item 12', hsn: '1234', quantity: 2, unitPricePaise: '11507', taxRateBp: 500, taxableValuePaise: '23014', taxPaise: '1151', cgstPaise: '576', sgstPaise: '575' }),
      item({ lineNo: 13, name: 'Preview Item 13', hsn: '1234', quantity: 3, unitPricePaise: '11644', taxRateBp: 1200, taxableValuePaise: '34932', taxPaise: '4192', cgstPaise: '2096', sgstPaise: '2096' }),
      item({ lineNo: 14, name: 'Preview Item 14', hsn: '1234', quantity: 4, unitPricePaise: '11781', taxRateBp: 1800, taxableValuePaise: '47124', taxPaise: '8482', cgstPaise: '4241', sgstPaise: '4241' }),
      item({ lineNo: 15, name: 'Preview Item 15', hsn: '1234', quantity: 5, unitPricePaise: '11918', taxRateBp: 2800, taxableValuePaise: '59590', taxPaise: '16685', cgstPaise: '8343', sgstPaise: '8342' }),
      item({ lineNo: 16, name: 'Preview Item 16', hsn: '1234', quantity: 1, unitPricePaise: '12055', taxRateBp: 0, taxableValuePaise: '12055', taxPaise: '0', cgstPaise: '0', sgstPaise: '0' }),
      item({ lineNo: 17, name: 'Preview Item 17', hsn: '1234', quantity: 2, unitPricePaise: '12192', taxRateBp: 500, taxableValuePaise: '24384', taxPaise: '1219', cgstPaise: '610', sgstPaise: '609' }),
      item({ lineNo: 18, name: 'Preview Item 18', hsn: '1234', quantity: 3, unitPricePaise: '12329', taxRateBp: 1200, taxableValuePaise: '36987', taxPaise: '4438', cgstPaise: '2219', sgstPaise: '2219' }),
      item({ lineNo: 19, name: 'Preview Item 19', hsn: '1234', quantity: 4, unitPricePaise: '12466', taxRateBp: 1800, taxableValuePaise: '49864', taxPaise: '8976', cgstPaise: '4488', sgstPaise: '4488' }),
      item({ lineNo: 20, name: 'Preview Item 20', hsn: '1234', quantity: 5, unitPricePaise: '12603', taxRateBp: 2800, taxableValuePaise: '63015', taxPaise: '17644', cgstPaise: '8822', sgstPaise: '8822' }),
      item({ lineNo: 21, name: 'Preview Item 21', hsn: '1234', quantity: 1, unitPricePaise: '12740', taxRateBp: 0, taxableValuePaise: '12740', taxPaise: '0', cgstPaise: '0', sgstPaise: '0' }),
      item({ lineNo: 22, name: 'Preview Item 22', hsn: '1234', quantity: 2, unitPricePaise: '12877', taxRateBp: 500, taxableValuePaise: '25754', taxPaise: '1288', cgstPaise: '644', sgstPaise: '644' }),
      item({ lineNo: 23, name: 'Preview Item 23', hsn: '1234', quantity: 3, unitPricePaise: '13014', taxRateBp: 1200, taxableValuePaise: '39042', taxPaise: '4685', cgstPaise: '2343', sgstPaise: '2342' }),
      item({ lineNo: 24, name: 'Preview Item 24', hsn: '1234', quantity: 4, unitPricePaise: '13151', taxRateBp: 1800, taxableValuePaise: '52604', taxPaise: '9469', cgstPaise: '4735', sgstPaise: '4734' }),
      item({ lineNo: 25, name: 'Preview Item 25', hsn: '1234', quantity: 5, unitPricePaise: '13288', taxRateBp: 2800, taxableValuePaise: '66440', taxPaise: '18603', cgstPaise: '9302', sgstPaise: '9301' }),
      item({ lineNo: 26, name: 'Preview Item 26', hsn: '1234', quantity: 1, unitPricePaise: '13425', taxRateBp: 0, taxableValuePaise: '13425', taxPaise: '0', cgstPaise: '0', sgstPaise: '0' }),
      item({ lineNo: 27, name: 'Preview Item 27', hsn: '1234', quantity: 2, unitPricePaise: '13562', taxRateBp: 500, taxableValuePaise: '27124', taxPaise: '1356', cgstPaise: '678', sgstPaise: '678' }),
      item({ lineNo: 28, name: 'Preview Item 28', hsn: '1234', quantity: 3, unitPricePaise: '13699', taxRateBp: 1200, taxableValuePaise: '41097', taxPaise: '4932', cgstPaise: '2466', sgstPaise: '2466' }),
      item({ lineNo: 29, name: 'Preview Item 29', hsn: '1234', quantity: 4, unitPricePaise: '13836', taxRateBp: 1800, taxableValuePaise: '55344', taxPaise: '9962', cgstPaise: '4981', sgstPaise: '4981' }),
      item({ lineNo: 30, name: 'Preview Item 30', hsn: '1234', quantity: 5, unitPricePaise: '13973', taxRateBp: 2800, taxableValuePaise: '69865', taxPaise: '19562', cgstPaise: '9781', sgstPaise: '9781' }),
      item({ lineNo: 31, name: 'Preview Item 31', hsn: '1234', quantity: 1, unitPricePaise: '14110', taxRateBp: 0, taxableValuePaise: '14110', taxPaise: '0', cgstPaise: '0', sgstPaise: '0' }),
      item({ lineNo: 32, name: 'Preview Item 32', hsn: '1234', quantity: 2, unitPricePaise: '14247', taxRateBp: 500, taxableValuePaise: '28494', taxPaise: '1425', cgstPaise: '713', sgstPaise: '712' }),
      item({ lineNo: 33, name: 'Preview Item 33', hsn: '1234', quantity: 3, unitPricePaise: '14384', taxRateBp: 1200, taxableValuePaise: '43152', taxPaise: '5178', cgstPaise: '2589', sgstPaise: '2589' }),
      item({ lineNo: 34, name: 'Preview Item 34', hsn: '1234', quantity: 4, unitPricePaise: '14521', taxRateBp: 1800, taxableValuePaise: '58084', taxPaise: '10455', cgstPaise: '5228', sgstPaise: '5227' }),
      item({ lineNo: 35, name: 'Preview Item 35', hsn: '1234', quantity: 5, unitPricePaise: '14658', taxRateBp: 2800, taxableValuePaise: '73290', taxPaise: '20521', cgstPaise: '10261', sgstPaise: '10260' }),
      item({ lineNo: 36, name: 'Preview Item 36', hsn: '1234', quantity: 1, unitPricePaise: '14795', taxRateBp: 0, taxableValuePaise: '14795', taxPaise: '0', cgstPaise: '0', sgstPaise: '0' }),
      item({ lineNo: 37, name: 'Preview Item 37', hsn: '1234', quantity: 2, unitPricePaise: '14932', taxRateBp: 500, taxableValuePaise: '29864', taxPaise: '1493', cgstPaise: '747', sgstPaise: '746' }),
      item({ lineNo: 38, name: 'Preview Item 38', hsn: '1234', quantity: 3, unitPricePaise: '15069', taxRateBp: 1200, taxableValuePaise: '45207', taxPaise: '5425', cgstPaise: '2713', sgstPaise: '2712' }),
      item({ lineNo: 39, name: 'Preview Item 39', hsn: '1234', quantity: 4, unitPricePaise: '15206', taxRateBp: 1800, taxableValuePaise: '60824', taxPaise: '10948', cgstPaise: '5474', sgstPaise: '5474' }),
      item({ lineNo: 40, name: 'Preview Item 40', hsn: '1234', quantity: 5, unitPricePaise: '15343', taxRateBp: 2800, taxableValuePaise: '76715', taxPaise: '21480', cgstPaise: '10740', sgstPaise: '10740' }),
    ],
  },
};

// --- The two real paths, calling the actual exported page functions -------
// (not a reimplementation of their logic — see the file header for why that
// distinction is the entire point of this test).

function renderPreviewPath(doc: Parameters<typeof renderPreviewBill>[0], fixture: BillSnapshot): string {
  const { blocks, skeleton } = renderPreviewBill(doc, fixture);
  return renderToStaticMarkup(React.createElement(BillBlocks, { blocks, skeleton }));
}

function renderProductionPath(layoutSnapshot: BillLayoutSnapshot, snapshot: BillSnapshot, merchant: BillMerchant): string {
  const { blocks, skeleton } = renderProductionBill(layoutSnapshot, snapshot, merchant);
  return renderToStaticMarkup(React.createElement(BillBlocks, { blocks, skeleton }));
}

describe('X-1: preview/production render parity', () => {
  for (const template of SEEDED_TEMPLATES) {
    const v2 = normalizeToV2(template.layoutSchema, template.skeleton);

    for (const [fixtureKey, fixture] of Object.entries(FIXTURES)) {
      it(`${template.name} x ${fixtureKey}: preview HTML === production HTML`, () => {
        // Fed the same merchant shape (name/addressLine1/gstin from the
        // fixture) to both paths so the comparison is genuinely
        // apples-to-apples on equivalent data, not coincidentally-equal
        // different data.
        const merchant: BillMerchant = {
          name: fixture.merchantName,
          addressLine1: fixture.merchantAddress,
          gstin: fixture.merchantGstin,
        };
        const layoutSnapshot: BillLayoutSnapshot = {
          schemaVersion: v2.schemaVersion,
          skeleton: v2.skeleton,
          blocks: v2.blocks,
          templateId: 'test-template',
          templateVersion: 1,
        };

        const previewHtml = renderPreviewPath(v2, fixture);
        const productionHtml = renderProductionPath(layoutSnapshot, fixture, merchant);

        expect(previewHtml).toBe(productionHtml);
        expect(previewHtml.length).toBeGreaterThan(0);
      });
    }
  }
});
