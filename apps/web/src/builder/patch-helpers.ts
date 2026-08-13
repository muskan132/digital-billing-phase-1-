// U-2: pure functions that produce a new draft `doc` from one field-level edit.
// Every function here takes only the fields it's allowed to write — `field`
// (a column's data binding) never appears as a parameter anywhere in this
// module, so no column-editing function is even CAPABLE of writing it. A
// rename is structurally incapable of becoming a rebind (Tier-1: field is
// what determines which real data value reaches the public bill page).
import { LayoutSchemaV2 } from '@digital-billing/block-manifest';

interface ColumnConfig {
  field: string;
  label: string;
  visible: boolean;
  align: 'left' | 'center' | 'right';
}

function mapBlock(doc: LayoutSchemaV2, blockId: string, fn: (props: Record<string, unknown>) => Record<string, unknown>): LayoutSchemaV2 {
  return {
    ...doc,
    blocks: doc.blocks.map((b) => (b.id === blockId ? { ...b, props: fn(b.props) } : b)),
  };
}

function mapColumns(props: Record<string, unknown>, fn: (columns: ColumnConfig[]) => ColumnConfig[]): Record<string, unknown> {
  const columns = (props.columns as ColumnConfig[] | undefined) ?? [];
  return { ...props, columns: fn(columns) };
}

export function setBlockPropString(doc: LayoutSchemaV2, blockId: string, propName: string, value: string): LayoutSchemaV2 {
  return mapBlock(doc, blockId, (props) => ({ ...props, [propName]: value }));
}

export function setBlockPropBoolean(doc: LayoutSchemaV2, blockId: string, propName: string, value: boolean): LayoutSchemaV2 {
  return mapBlock(doc, blockId, (props) => ({ ...props, [propName]: value }));
}

// secondaryFields is a picker over bindableFields, not free text — the caller
// (ComponentsTab) only ever offers checkboxes for values already in
// BLOCK_MANIFEST[type].bindableFields, so this never needs its own whitelist
// check here; it just writes whatever list it's given.
export function setSecondaryFields(doc: LayoutSchemaV2, blockId: string, values: string[]): LayoutSchemaV2 {
  return mapBlock(doc, blockId, (props) => ({ ...props, secondaryFields: values }));
}

export function setColumnLabel(doc: LayoutSchemaV2, blockId: string, columnIndex: number, label: string): LayoutSchemaV2 {
  return mapBlock(doc, blockId, (props) =>
    mapColumns(props, (columns) => columns.map((c, i) => (i === columnIndex ? { ...c, label } : c))),
  );
}

export function setColumnVisible(doc: LayoutSchemaV2, blockId: string, columnIndex: number, visible: boolean): LayoutSchemaV2 {
  return mapBlock(doc, blockId, (props) =>
    mapColumns(props, (columns) => columns.map((c, i) => (i === columnIndex ? { ...c, visible } : c))),
  );
}

export function setColumnAlign(doc: LayoutSchemaV2, blockId: string, columnIndex: number, align: ColumnConfig['align']): LayoutSchemaV2 {
  return mapBlock(doc, blockId, (props) =>
    mapColumns(props, (columns) => columns.map((c, i) => (i === columnIndex ? { ...c, align } : c))),
  );
}

// Buttons only (D-36 scopes @dnd-kit to the BILL tab). Swaps two adjacent
// entries; a no-op past either boundary rather than throwing, since a
// disabled button should never be reachable but a stray call shouldn't crash
// the draft either.
export function moveColumn(doc: LayoutSchemaV2, blockId: string, index: number, direction: 'up' | 'down'): LayoutSchemaV2 {
  const target = direction === 'up' ? index - 1 : index + 1;
  return mapBlock(doc, blockId, (props) =>
    mapColumns(props, (columns) => {
      if (target < 0 || target >= columns.length) {
        return columns;
      }
      const next = [...columns];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    }),
  );
}
