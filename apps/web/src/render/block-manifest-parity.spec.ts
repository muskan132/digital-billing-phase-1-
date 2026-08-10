import { BLOCK_TYPES, BLOCK_MANIFEST } from '@digital-billing/block-manifest';
import { renderTemplate, LayoutBlock, BillSnapshot, BillMerchant } from './template-renderer';

// Bidirectional check between the block manifest (D-30) and the renderer
// (renderBlock's switch in template-renderer.ts):
//
// 1. "every manifest entry has a renderer" — proven below by rendering one
//    minimal block of each BLOCK_TYPES value and asserting it does NOT throw
//    the "Unknown block type" error renderBlock raises for anything outside
//    isKnownBlockType. Since template-renderer.ts now imports BlockType from
//    this same manifest package (no local duplicate), a manifest entry with
//    no matching switch case is a *compile-time* failure already — renderBlock
//    has an explicit RenderedBlock return type and no default case, so an
//    unhandled BlockType leaves a code path that falls off the end of the
//    switch without returning, which TypeScript rejects (TS2366: "Function
//    lacks ending return statement and return type does not include
//    'undefined'"). Deleting a switch case therefore fails `tsc`, not just
//    this test.
// 2. "every renderer has a manifest entry" is structurally guaranteed by (1)'s
//    same import: renderBlock can only be called with a BlockType value, and
//    BlockType is defined as `(typeof BLOCK_TYPES)[number]` — there is no
//    third list to drift out of sync with.
const MINIMAL_SNAPSHOT: BillSnapshot = {
  merchantName: 'Test Merchant',
  amountPaise: '10000',
  currency: 'INR',
  items: [
    {
      lineNo: 1,
      name: 'Test Item',
      hsn: '1234',
      uom: 'PCS',
      quantity: 1,
      unitPricePaise: '10000',
      itemDiscountPaise: '0',
      billDiscountAllocPaise: '0',
      taxRateBp: 0,
      taxableValuePaise: '10000',
      taxPaise: '0',
      cgstPaise: '0',
      sgstPaise: '0',
      igstPaise: '0',
    },
  ],
};
const MINIMAL_MERCHANT: BillMerchant = { name: 'Test Merchant' };

describe('block manifest <-> renderer parity', () => {
  it.each(BLOCK_TYPES)('%s renders without an "Unknown block type" error', (type) => {
    const block: LayoutBlock = { type, order: 1, props: BLOCK_MANIFEST[type].defaults };
    expect(() => renderTemplate([block], MINIMAL_SNAPSHOT, MINIMAL_MERCHANT)).not.toThrow();
  });

  it('an out-of-manifest type is rejected, not silently skipped (D-10)', () => {
    const block = { type: 'NOT_A_REAL_BLOCK', order: 1, props: {} } as unknown as LayoutBlock;
    expect(() => renderTemplate([block], MINIMAL_SNAPSHOT, MINIMAL_MERCHANT)).toThrow('Unknown block type');
  });
});
