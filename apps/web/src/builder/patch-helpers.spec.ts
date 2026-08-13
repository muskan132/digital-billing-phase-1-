import { LayoutSchemaV2 } from '@digital-billing/block-manifest';
import { moveColumn, setBlockPropBoolean, setBlockPropString, setColumnAlign, setColumnLabel, setColumnVisible, setSecondaryFields } from './patch-helpers';

const COLUMNS = [
  { field: 'name', label: 'ITEM', visible: true, align: 'left' as const },
  { field: 'hsn', label: 'HSN', visible: true, align: 'left' as const },
  { field: 'amountPaise', label: 'AMOUNT', visible: true, align: 'right' as const },
];

const DOC: LayoutSchemaV2 = {
  schemaVersion: 2,
  skeleton: 'RETAIL',
  blocks: [
    { id: 'blk_header', type: 'HEADER', order: 1, props: {}, visible: true, width: 'full' },
    { id: 'blk_merchant', type: 'MERCHANT_INFO', order: 2, props: { variant: 'receipt' }, visible: true, width: 'full' },
    { id: 'blk_items', type: 'ITEMS', order: 3, props: { columns: COLUMNS, secondaryFields: [] }, visible: true, width: 'full' },
  ],
};

describe('patch-helpers (U-2)', () => {
  it('setBlockPropString only changes the targeted prop on the targeted block; siblings untouched', () => {
    const result = setBlockPropString(DOC, 'blk_merchant', 'variant', 'tax_invoice');

    expect(result.blocks[1].props.variant).toBe('tax_invoice');
    expect(result.blocks[0]).toBe(DOC.blocks[0]); // untouched block: same reference
    expect(result.blocks[2]).toBe(DOC.blocks[2]);
  });

  it('setBlockPropBoolean writes only the named boolean prop', () => {
    const withBool = setBlockPropString(DOC, 'blk_header', 'someFlag', 'placeholder');
    const result = setBlockPropBoolean(withBool, 'blk_header', 'someFlag', true);
    expect(result.blocks[0].props.someFlag).toBe(true);
  });

  it('setSecondaryFields writes the given list verbatim', () => {
    const result = setSecondaryFields(DOC, 'blk_items', ['hsn', 'uom']);
    expect(result.blocks[2].props.secondaryFields).toEqual(['hsn', 'uom']);
  });

  it('setColumnLabel changes only the targeted column label — field, visible, align untouched', () => {
    const result = setColumnLabel(DOC, 'blk_items', 0, 'Product Name');
    const columns = result.blocks[2].props.columns as typeof COLUMNS;

    expect(columns[0]).toEqual({ field: 'name', label: 'Product Name', visible: true, align: 'left' });
    expect(columns[1]).toEqual(COLUMNS[1]); // sibling column fully untouched
    expect(columns[2]).toEqual(COLUMNS[2]);
  });

  it('setColumnVisible toggles only visible, never field', () => {
    const result = setColumnVisible(DOC, 'blk_items', 1, false);
    const columns = result.blocks[2].props.columns as typeof COLUMNS;

    expect(columns[1]).toEqual({ field: 'hsn', label: 'HSN', visible: false, align: 'left' });
  });

  it('setColumnAlign changes only align, never field', () => {
    const result = setColumnAlign(DOC, 'blk_items', 2, 'center');
    const columns = result.blocks[2].props.columns as typeof COLUMNS;

    expect(columns[2]).toEqual({ field: 'amountPaise', label: 'AMOUNT', visible: true, align: 'center' });
  });

  it('moveColumn swaps two adjacent columns, preserving every field value exactly', () => {
    const result = moveColumn(DOC, 'blk_items', 0, 'down');
    const columns = result.blocks[2].props.columns as typeof COLUMNS;

    expect(columns[0]).toEqual(COLUMNS[1]);
    expect(columns[1]).toEqual(COLUMNS[0]);
    expect(columns[2]).toEqual(COLUMNS[2]);
    expect(columns.map((c) => c.field)).toEqual(['hsn', 'name', 'amountPaise']);
  });

  it('moveColumn is a no-op past either boundary — does not throw, does not corrupt', () => {
    const first = moveColumn(DOC, 'blk_items', 0, 'up');
    const last = moveColumn(DOC, 'blk_items', 2, 'down');

    expect((first.blocks[2].props.columns as typeof COLUMNS)).toEqual(COLUMNS);
    expect((last.blocks[2].props.columns as typeof COLUMNS)).toEqual(COLUMNS);
  });

  it('no patch-helper function accepts a "field" argument — every column mutation preserves field across all four operations', () => {
    const originalFields = COLUMNS.map((c) => c.field);

    const afterLabel = setColumnLabel(DOC, 'blk_items', 0, 'Renamed');
    const afterVisible = setColumnVisible(afterLabel, 'blk_items', 0, false);
    const afterAlign = setColumnAlign(afterVisible, 'blk_items', 0, 'right');
    const afterMove = moveColumn(afterAlign, 'blk_items', 0, 'down');

    const finalFields = (afterMove.blocks[2].props.columns as typeof COLUMNS).map((c) => c.field);
    expect(finalFields.sort()).toEqual([...originalFields].sort());
  });

  it('an XSS-shaped label round-trips as inert string data — write time does no sanitizing or escaping (JSX handles that at render)', () => {
    const malicious = '<script>alert(1)</script>';
    const result = setColumnLabel(DOC, 'blk_items', 0, malicious);
    const columns = result.blocks[2].props.columns as typeof COLUMNS;
    expect(columns[0].label).toBe(malicious); // stored verbatim, not mutated either direction
  });

  it('never mutates the input doc (immutability)', () => {
    const before = JSON.stringify(DOC);
    setColumnLabel(DOC, 'blk_items', 0, 'changed');
    setBlockPropString(DOC, 'blk_header', 'x', 'y');
    expect(JSON.stringify(DOC)).toBe(before);
  });
});
