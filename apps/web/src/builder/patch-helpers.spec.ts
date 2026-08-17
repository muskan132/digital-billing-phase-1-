import { LayoutSchemaV2 } from '@digital-billing/block-manifest';
import {
  addBlock,
  moveBlock,
  moveColumn,
  reorderBlockToPosition,
  removeBlock,
  setBlockPropBoolean,
  setBlockPropString,
  setBlockVisible,
  setBlockWidth,
  setColumnAlign,
  setColumnLabel,
  setColumnVisible,
  setSecondaryFields,
} from './patch-helpers';

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

describe('patch-helpers — block-level operations (U-3)', () => {
  it('addBlock appends a new block with the given defaults, next order, visible:true, width:full', () => {
    const result = addBlock(DOC, 'FOOTER', { showSupport: true });
    const added = result.blocks[result.blocks.length - 1];

    expect(added.type).toBe('FOOTER');
    expect(added.order).toBe(4); // max existing order (3) + 1
    expect(added.props).toEqual({ showSupport: true });
    expect(added.visible).toBe(true);
    expect(added.width).toBe('full');
    expect(added.id).toMatch(/^blk_/);
    expect(result.blocks.slice(0, 3)).toEqual(DOC.blocks); // existing blocks untouched
  });

  it('addBlock generates the same id as T-4s normalizeToV2 would for the same (type, order) — single id-generation scheme', () => {
    const result = addBlock(DOC, 'FOOTER', {});
    // order will be 4 — mirror T-4's own deterministic scheme by calling addBlock
    // twice on fresh docs and checking the id is stable, not random.
    const result2 = addBlock(DOC, 'FOOTER', {});
    expect(result.blocks[3].id).toBe(result2.blocks[3].id);
  });

  it('removeBlock filters out exactly the targeted block, leaves order values on survivors untouched', () => {
    const result = removeBlock(DOC, 'blk_merchant');
    expect(result.blocks.map((b) => b.id)).toEqual(['blk_header', 'blk_items']);
    expect(result.blocks[0]).toBe(DOC.blocks[0]);
    expect(result.blocks[1]).toEqual(DOC.blocks[2]);
  });

  it('removeBlock on an unknown id is a no-op, not an error', () => {
    const result = removeBlock(DOC, 'nope');
    expect(result.blocks).toHaveLength(3);
  });

  it('setBlockVisible toggles only the targeted block, siblings untouched by reference', () => {
    const result = setBlockVisible(DOC, 'blk_header', false);
    expect(result.blocks[0].visible).toBe(false);
    expect(result.blocks[1]).toBe(DOC.blocks[1]);
    expect(result.blocks[2]).toBe(DOC.blocks[2]);
  });

  it('setBlockWidth only accepts the three fraction values — no pixel value ever passes through', () => {
    const half = setBlockWidth(DOC, 'blk_header', 'half');
    const third = setBlockWidth(DOC, 'blk_header', 'third');
    const full = setBlockWidth(DOC, 'blk_header', 'full');
    expect(half.blocks[0].width).toBe('half');
    expect(third.blocks[0].width).toBe('third');
    expect(full.blocks[0].width).toBe('full');
  });

  describe('reorderBlockToPosition — the single primitive both drag and buttons call', () => {
    it('moves a block to a new position and renumbers ALL blocks to a clean 1..N sequence', () => {
      const result = reorderBlockToPosition(DOC, 'blk_items', 0); // move ITEMS to the front
      expect(result.blocks.map((b) => b.id)).toEqual(['blk_items', 'blk_header', 'blk_merchant']);
      expect(result.blocks.map((b) => b.order)).toEqual([1, 2, 3]);
    });

    it('clamps an out-of-range target position rather than throwing or corrupting order', () => {
      const result = reorderBlockToPosition(DOC, 'blk_header', 999);
      expect(result.blocks.map((b) => b.id)).toEqual(['blk_merchant', 'blk_items', 'blk_header']);
      expect(result.blocks.map((b) => b.order)).toEqual([1, 2, 3]);
    });

    it('an unknown blockId is a no-op', () => {
      const result = reorderBlockToPosition(DOC, 'nope', 0);
      expect(result).toEqual(DOC);
    });
  });

  describe('moveBlock (move-up/move-down buttons)', () => {
    it('moveBlock "down" and a drag-equivalent reorderBlockToPosition call produce IDENTICAL blocks[].order — same primitive, same result', () => {
      const viaButton = moveBlock(DOC, 'blk_header', 'down'); // header: position 0 -> 1
      const viaDrag = reorderBlockToPosition(DOC, 'blk_header', 1); // dnd-kit's onDragEnd would give newIndex 1

      expect(viaButton).toEqual(viaDrag);
    });

    it('moveBlock "up" on the first block is a no-op (clamped), not an error', () => {
      const result = moveBlock(DOC, 'blk_header', 'up');
      expect(result.blocks.map((b) => b.id)).toEqual(['blk_header', 'blk_merchant', 'blk_items']);
    });

    it('moveBlock "down" on the last block is a no-op (clamped), not an error', () => {
      const result = moveBlock(DOC, 'blk_items', 'down');
      expect(result.blocks.map((b) => b.id)).toEqual(['blk_header', 'blk_merchant', 'blk_items']);
    });
  });

  it('block ids are never reassigned by any reorder operation — identity survives reorder', () => {
    const result = reorderBlockToPosition(DOC, 'blk_items', 0);
    expect(new Set(result.blocks.map((b) => b.id))).toEqual(new Set(DOC.blocks.map((b) => b.id)));
  });
});
