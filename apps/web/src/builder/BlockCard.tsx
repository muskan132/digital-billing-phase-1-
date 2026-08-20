'use client';

// One block = one card, combining what used to be ComponentsTab's per-block prop
// editor and BillTab's per-block layout row into a single section (split-view
// redesign, post-X-2). Every merchant-typed string here is still rendered via plain
// JSX children/value attributes only — no dangerouslySetInnerHTML — same invariant
// ComponentsTab.tsx held (Tier-1: these strings reach the public bill page). `field`
// is still plain text, never an input — no control here can write it.
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { BLOCK_MANIFEST, BlockType, LayoutBlockV2, LayoutSchemaV2 } from '@digital-billing/block-manifest';
import {
  moveBlock,
  moveColumn,
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

interface ColumnConfig {
  field: string;
  label: string;
  visible: boolean;
  align: 'left' | 'center' | 'right';
}

export interface BlockCardProps {
  block: LayoutBlockV2;
  index: number;
  total: number;
  doc: LayoutSchemaV2;
  onEdit: (doc: LayoutSchemaV2) => void;
  onEditDebounced: (doc: LayoutSchemaV2) => void;
}

export function BlockCard({ block, index, total, doc, onEdit, onEditDebounced }: BlockCardProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: block.id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  const manifestEntry = BLOCK_MANIFEST[block.type as BlockType];

  return (
    <section ref={setNodeRef} style={style} className="block-card">
      <header className="block-card-header">
        {/* The drag handle is an ENHANCEMENT over the buttons beside it, not a
            replacement — every one of these buttons works with drag entirely absent (D-36). */}
        <span className="block-card-drag-handle" {...attributes} {...listeners} aria-label={`Drag to reorder ${block.type}`}>
          ⠿
        </span>
        <h3>{block.type}</h3>

        <button type="button" onClick={() => onEdit(moveBlock(doc, block.id, 'up'))} disabled={index === 0}>
          ↑
        </button>
        <button type="button" onClick={() => onEdit(moveBlock(doc, block.id, 'down'))} disabled={index === total - 1}>
          ↓
        </button>

        <label className="block-card-visible">
          <input
            type="checkbox"
            checked={block.visible}
            onChange={(e) => onEdit(setBlockVisible(doc, block.id, e.target.checked))}
          />
          Visible
        </label>

        <select value={block.width} onChange={(e) => onEdit(setBlockWidth(doc, block.id, e.target.value as LayoutBlockV2['width']))}>
          <option value="full">full</option>
          <option value="half">half</option>
          <option value="third">third</option>
        </select>

        <button type="button" className="block-card-remove" onClick={() => onEdit(removeBlock(doc, block.id))}>
          Remove
        </button>
      </header>

      <div className="block-card-body">
        {!manifestEntry && (
          // T-6 rejects unknown types before this could ever be saved — this is
          // just "don't crash the editor" for an in-progress invalid draft.
          <p>Unknown block type — no editor available.</p>
        )}

        {manifestEntry && Object.entries(manifestEntry.props).length === 0 && <p>No editable properties for this block.</p>}

        {manifestEntry &&
          Object.entries(manifestEntry.props).map(([propName, spec]) => {
            if (spec.type === 'columns') {
              const columns = (block.props[propName] as ColumnConfig[] | undefined) ?? [];
              return (
                <ColumnEditor
                  key={propName}
                  blockId={block.id}
                  columns={columns}
                  doc={doc}
                  onEdit={onEdit}
                  onEditDebounced={onEditDebounced}
                />
              );
            }

            if (spec.type === 'stringArray') {
              const selected = (block.props[propName] as string[] | undefined) ?? [];
              const bindable = manifestEntry.bindableFields ?? [];
              return (
                <fieldset key={propName}>
                  <legend>{propName}</legend>
                  {bindable.map((fieldName) => (
                    <label key={fieldName}>
                      <input
                        type="checkbox"
                        checked={selected.includes(fieldName)}
                        onChange={(e) => {
                          const next = e.target.checked ? [...selected, fieldName] : selected.filter((f) => f !== fieldName);
                          onEdit(setSecondaryFields(doc, block.id, next));
                        }}
                      />
                      {fieldName}
                    </label>
                  ))}
                </fieldset>
              );
            }

            if (spec.type === 'boolean') {
              const value = Boolean(block.props[propName]);
              return (
                <label key={propName} className="components-tab-field">
                  <input
                    type="checkbox"
                    checked={value}
                    onChange={(e) => onEdit(setBlockPropBoolean(doc, block.id, propName, e.target.checked))}
                  />
                  {propName}
                </label>
              );
            }

            // 'string'
            const value = typeof block.props[propName] === 'string' ? (block.props[propName] as string) : '';
            return (
              <label key={propName} className="components-tab-field">
                {propName}
                <input
                  type="text"
                  value={value}
                  onChange={(e) => onEditDebounced(setBlockPropString(doc, block.id, propName, e.target.value))}
                />
              </label>
            );
          })}
      </div>
    </section>
  );
}

interface ColumnEditorProps {
  blockId: string;
  columns: ColumnConfig[];
  doc: LayoutSchemaV2;
  onEdit: (doc: LayoutSchemaV2) => void;
  onEditDebounced: (doc: LayoutSchemaV2) => void;
}

function ColumnEditor({ blockId, columns, doc, onEdit, onEditDebounced }: ColumnEditorProps) {
  return (
    <table className="components-tab-columns">
      <thead>
        <tr>
          <th>Field</th>
          <th>Label</th>
          <th>Visible</th>
          <th>Align</th>
          <th>Order</th>
        </tr>
      </thead>
      <tbody>
        {columns.map((column, index) => (
          <tr key={column.field}>
            {/* Plain text, never an input — field is not editable anywhere on
                this page, structurally: no onChange exists that could write it. */}
            <td>
              <code>{column.field}</code>
            </td>
            <td>
              <input
                type="text"
                value={column.label}
                onChange={(e) => onEditDebounced(setColumnLabel(doc, blockId, index, e.target.value))}
              />
            </td>
            <td>
              <input
                type="checkbox"
                checked={column.visible}
                onChange={(e) => onEdit(setColumnVisible(doc, blockId, index, e.target.checked))}
              />
            </td>
            <td>
              <select
                value={column.align}
                onChange={(e) => onEdit(setColumnAlign(doc, blockId, index, e.target.value as ColumnConfig['align']))}
              >
                <option value="left">left</option>
                <option value="center">center</option>
                <option value="right">right</option>
              </select>
            </td>
            <td>
              <button type="button" disabled={index === 0} onClick={() => onEdit(moveColumn(doc, blockId, index, 'up'))}>
                ↑
              </button>
              <button
                type="button"
                disabled={index === columns.length - 1}
                onClick={() => onEdit(moveColumn(doc, blockId, index, 'down'))}
              >
                ↓
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
