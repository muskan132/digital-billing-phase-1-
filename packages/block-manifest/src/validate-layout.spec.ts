import { BLOCK_MANIFEST } from './index';
import { LayoutBlockV2, LayoutSchemaV2 } from './normalize-layout';
import { validateLayoutSchema } from './validate-layout';

function block(overrides: Partial<LayoutBlockV2> & Pick<LayoutBlockV2, 'id' | 'type' | 'order'>): LayoutBlockV2 {
  return { props: {}, visible: true, width: 'full', ...overrides };
}

function doc(blocks: LayoutBlockV2[]): LayoutSchemaV2 {
  return { schemaVersion: 2, skeleton: 'MINIMALIST', blocks };
}

const VALID_DOC = doc([
  block({ id: 'blk_1', type: 'HEADER', order: 1 }),
  block({ id: 'blk_2', type: 'MERCHANT_INFO', order: 2 }),
  block({ id: 'blk_3', type: 'ITEMS', order: 3 }),
  block({ id: 'blk_4', type: 'TOTAL', order: 4 }),
  block({ id: 'blk_5', type: 'FOOTER', order: 5 }),
]);

// A real seeded RECEIPT template's post-T-5 v2 blocks, copied verbatim from
// the running dev DB (GET /v1/templates -> seed-template-receipt) — not
// hand-simplified, so this exercises the actual production document shape.
const SEEDED_RECEIPT_DOC: LayoutSchemaV2 = {
  schemaVersion: 2,
  skeleton: 'MINIMALIST',
  blocks: [
    { id: 'blk_0cm6d3h', type: 'HEADER', order: 1, props: {}, width: 'full', visible: true },
    { id: 'blk_1nuu5cq', type: 'MERCHANT_INFO', order: 2, props: {}, width: 'full', visible: true },
    { id: 'blk_01i47lg', type: 'ITEMS', order: 3, props: {}, width: 'full', visible: true },
    { id: 'blk_10ohjk3', type: 'TOTAL', order: 4, props: {}, width: 'full', visible: true },
    { id: 'blk_10cvwq1', type: 'PAYMENT_DETAILS', order: 5, props: {}, width: 'full', visible: true },
    { id: 'blk_0hkeyi2', type: 'FOOTER', order: 6, props: {}, width: 'full', visible: true },
  ],
};

// A real seeded TAX_INVOICE (TAX_COMPLIANT) template — exercises the
// `columns`/`secondaryFields`/`mode`/`basis` prop shapes T-6 must accept.
const SEEDED_TAX_INVOICE_DOC: LayoutSchemaV2 = {
  schemaVersion: 2,
  skeleton: 'TAX_COMPLIANT',
  blocks: [
    { id: 'blk_0cm6d3h', type: 'HEADER', order: 1, props: {}, width: 'full', visible: true },
    { id: 'blk_1nuu5cq', type: 'MERCHANT_INFO', order: 2, props: { variant: 'tax_invoice' }, width: 'full', visible: true },
    {
      id: 'blk_01i47lg',
      type: 'ITEMS',
      order: 3,
      props: {
        columns: [
          { align: 'left', field: 'name', label: 'DESCRIPTION', visible: true },
          { align: 'left', field: 'hsn', label: 'HSN', visible: true },
          { align: 'center', field: 'quantity', label: 'QTY', visible: true },
          { align: 'right', field: 'unitPricePaise', label: 'RATE', visible: true },
          { align: 'right', field: 'taxRateBp', label: 'GST%', visible: true },
          { align: 'right', field: 'amountPaise', label: 'AMOUNT', visible: true },
        ],
        secondaryFields: [],
      },
      width: 'full',
      visible: true,
    },
    { id: 'blk_10ohjk3', type: 'TOTAL', order: 4, props: { basis: 'pre_tax' }, width: 'full', visible: true },
    { id: 'blk_1jiwb38', type: 'TAX_SUMMARY', order: 5, props: { mode: 'auto' }, width: 'full', visible: true },
    { id: 'blk_1nrgcng', type: 'AMOUNT_PAYABLE', order: 6, props: {}, width: 'full', visible: true },
    { id: 'blk_0huek71', type: 'FOOTER', order: 7, props: {}, width: 'full', visible: true },
  ],
};

describe('validateLayoutSchema', () => {
  it('passes a valid document with zero issues', () => {
    expect(validateLayoutSchema(VALID_DOC, BLOCK_MANIFEST)).toEqual([]);
  });

  it('passes the real seeded RECEIPT template clean', () => {
    expect(validateLayoutSchema(SEEDED_RECEIPT_DOC, BLOCK_MANIFEST)).toEqual([]);
  });

  it('passes the real seeded TAX_INVOICE template clean', () => {
    expect(validateLayoutSchema(SEEDED_TAX_INVOICE_DOC, BLOCK_MANIFEST)).toEqual([]);
  });

  describe('known types only', () => {
    it('flags exactly one issue naming the offending block for an unknown type', () => {
      const withUnknown = doc([...VALID_DOC.blocks, block({ id: 'blk_bad', type: 'NOT_A_TYPE', order: 6 })]);
      const issues = validateLayoutSchema(withUnknown, BLOCK_MANIFEST);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toEqual({ severity: 'error', blockId: 'blk_bad', message: 'Unknown block type "NOT_A_TYPE"' });
    });
  });

  describe('HEADER + ITEMS/CHARGES presence (D-31)', () => {
    it('flags a document-level issue (no blockId) when HEADER is entirely absent', () => {
      const noHeader = doc(VALID_DOC.blocks.filter((b) => b.type !== 'HEADER'));
      const issues = validateLayoutSchema(noHeader, BLOCK_MANIFEST);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toEqual({ severity: 'error', message: 'A visible HEADER block is required' });
    });

    it('flags HEADER present but visible:false the same as HEADER absent', () => {
      const hiddenHeader = doc(VALID_DOC.blocks.map((b) => (b.type === 'HEADER' ? { ...b, visible: false } : b)));
      const issues = validateLayoutSchema(hiddenHeader, BLOCK_MANIFEST);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toEqual({ severity: 'error', message: 'A visible HEADER block is required' });
    });

    it('flags a document-level issue when neither ITEMS nor CHARGES is visible', () => {
      const noItems = doc(VALID_DOC.blocks.filter((b) => b.type !== 'ITEMS'));
      const issues = validateLayoutSchema(noItems, BLOCK_MANIFEST);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toEqual({ severity: 'error', message: 'A visible ITEMS or CHARGES block is required' });
    });

    it('accepts CHARGES as satisfying the ITEMS/CHARGES requirement even though it has no manifest entry (and separately flags it as unknown)', () => {
      const withCharges = doc(VALID_DOC.blocks.map((b) => (b.type === 'ITEMS' ? { ...b, type: 'CHARGES' } : b)));
      const issues = validateLayoutSchema(withCharges, BLOCK_MANIFEST);
      // CHARGES satisfies the presence rule, but is still an unknown type today (T-3 scope).
      expect(issues).toEqual([{ severity: 'error', blockId: 'blk_3', message: 'Unknown block type "CHARGES"' }]);
    });

    it('an empty blocks array produces BOTH the missing-HEADER and missing-ITEMS/CHARGES issues, not a crash or a single combined issue', () => {
      const empty = doc([]);
      const issues = validateLayoutSchema(empty, BLOCK_MANIFEST);
      expect(issues).toEqual([
        { severity: 'error', message: 'A visible HEADER block is required' },
        { severity: 'error', message: 'A visible ITEMS or CHARGES block is required' },
      ]);
    });
  });

  describe('order uniqueness', () => {
    it('flags exactly one issue naming the second block sharing an order value', () => {
      const dup = doc(VALID_DOC.blocks.map((b, i) => (i === 4 ? { ...b, order: 1 } : b)));
      const issues = validateLayoutSchema(dup, BLOCK_MANIFEST);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toEqual({ severity: 'error', blockId: 'blk_5', message: 'Duplicate order 1' });
    });
  });

  describe('block id uniqueness', () => {
    it('flags exactly one issue naming the second block sharing an id', () => {
      const dup = doc(VALID_DOC.blocks.map((b, i) => (i === 4 ? { ...b, id: 'blk_1' } : b)));
      const issues = validateLayoutSchema(dup, BLOCK_MANIFEST);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toEqual({ severity: 'error', blockId: 'blk_1', message: 'Duplicate block id "blk_1"' });
    });
  });

  describe('props validation', () => {
    it('flags exactly one issue naming the block for a wrong-type prop', () => {
      const badVariant = doc(VALID_DOC.blocks.map((b) => (b.type === 'MERCHANT_INFO' ? { ...b, props: { variant: 42 } } : b)));
      const issues = validateLayoutSchema(badVariant, BLOCK_MANIFEST);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toEqual({ severity: 'error', blockId: 'blk_2', message: 'MERCHANT_INFO: prop "variant" must be a string' });
    });

    it('flags exactly one issue naming the block for a stringArray prop with a non-string element', () => {
      const badSecondary = doc(VALID_DOC.blocks.map((b) => (b.type === 'ITEMS' ? { ...b, props: { secondaryFields: ['hsn', 1] } } : b)));
      const issues = validateLayoutSchema(badSecondary, BLOCK_MANIFEST);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toEqual({ severity: 'error', blockId: 'blk_3', message: 'ITEMS: prop "secondaryFields" must be an array of strings' });
    });

    it('flags a columns entry whose field is not in bindableFields, naming the block', () => {
      const badField = doc(
        VALID_DOC.blocks.map((b) =>
          b.type === 'ITEMS' ? { ...b, props: { columns: [{ field: 'not_a_field', label: 'X', visible: true, align: 'left' }] } } : b,
        ),
      );
      const issues = validateLayoutSchema(badField, BLOCK_MANIFEST);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toEqual({ severity: 'error', blockId: 'blk_3', message: 'ITEMS: "columns" column has an invalid field "not_a_field"' });
    });

    it('does not flag a missing optional prop', () => {
      // Every prop in BLOCK_MANIFEST today is optional (required: false) — no
      // manifest entry currently has a required prop to test against, so this
      // documents the current absence-is-fine behavior rather than asserting
      // a required-prop failure that no real block type exercises yet.
      const issues = validateLayoutSchema(VALID_DOC, BLOCK_MANIFEST);
      expect(issues).toEqual([]);
    });
  });
});
