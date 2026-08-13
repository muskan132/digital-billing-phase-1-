'use client';

// U-2: COMPONENTS tab — per-block prop editor generated from BLOCK_MANIFEST.
// Every merchant-typed string here (label, and any future string prop) is
// rendered via plain JSX children/value attributes only — no
// dangerouslySetInnerHTML anywhere in this file, same invariant BillBlocks.tsx
// already holds for the production renderer (Tier-1: these strings reach the
// public bill page). `field` is rendered as plain text, never an input —
// there is no control on the page a merchant (or an attacker abusing the
// label field) could use to change it, because none exists.
import { BLOCK_MANIFEST, BlockType, LayoutSchemaV2 } from '@digital-billing/block-manifest';
import { moveColumn, setBlockPropBoolean, setBlockPropString, setColumnAlign, setColumnLabel, setColumnVisible, setSecondaryFields } from './patch-helpers';

interface ColumnConfig {
  field: string;
  label: string;
  visible: boolean;
  align: 'left' | 'center' | 'right';
}

export interface ComponentsTabProps {
  doc: LayoutSchemaV2;
  onEdit: (doc: LayoutSchemaV2) => void;
  onEditDebounced: (doc: LayoutSchemaV2) => void;
}

export function ComponentsTab({ doc, onEdit, onEditDebounced }: ComponentsTabProps) {
  return (
    <div className="components-tab">
      {doc.blocks.map((block) => {
        const manifestEntry = BLOCK_MANIFEST[block.type as BlockType];
        if (!manifestEntry) {
          // T-6 rejects unknown types before this could ever be saved — this
          // is just "don't crash the editor" for an in-progress invalid draft.
          return (
            <section key={block.id} className="components-tab-block">
              <h3>{block.type}</h3>
              <p>Unknown block type — no editor available.</p>
            </section>
          );
        }

        const propEntries = Object.entries(manifestEntry.props);

        return (
          <section key={block.id} className="components-tab-block">
            <h3>{block.type}</h3>
            {propEntries.length === 0 && <p>No editable properties for this block.</p>}

            {propEntries.map(([propName, spec]) => {
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
          </section>
        );
      })}
    </div>
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
