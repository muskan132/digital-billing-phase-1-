'use client';

// U-3: BILL tab. Every mutation — drag OR button — funnels through the exact same
// patch-helpers functions (reorderBlockToPosition/moveBlock, setBlockWidth,
// setBlockVisible, removeBlock, addBlock). Drag is a pure input-method layer on top:
// deleting @dnd-kit later means deleting the DndContext/useSortable wiring below,
// not any stored data or any of the always-present controls, which call the same
// functions directly and never touch drag state (D-36).
import { DndContext, DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { BLOCK_MANIFEST, BlockType, LayoutBlockV2, LayoutSchemaV2 } from '@digital-billing/block-manifest';
import { addBlock, moveBlock, removeBlock, reorderBlockToPosition, setBlockVisible, setBlockWidth } from './patch-helpers';

export interface BillTabProps {
  doc: LayoutSchemaV2;
  onEdit: (doc: LayoutSchemaV2) => void;
}

export function BillTab({ doc, onEdit }: BillTabProps) {
  const sensors = useSensors(useSensor(PointerSensor));
  const sorted = [...doc.blocks].sort((a, b) => a.order - b.order);

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) {
      return;
    }
    const newIndex = sorted.findIndex((b) => b.id === over.id);
    if (newIndex === -1) {
      return;
    }
    onEdit(reorderBlockToPosition(doc, String(active.id), newIndex));
  }

  return (
    <div className="bill-tab">
      <section className="bill-tab-palette">
        <h3>Add a block</h3>
        {Object.keys(BLOCK_MANIFEST).map((type) => (
          <button
            key={type}
            type="button"
            onClick={() => onEdit(addBlock(doc, type, BLOCK_MANIFEST[type as BlockType].defaults))}
          >
            + {type}
          </button>
        ))}
      </section>

      <section className="bill-tab-blocks">
        <h3>Blocks</h3>
        {/* Drag disabled entirely (JS off, or DndContext removed) still leaves a
            fully operable list — every row below has its own move-up/move-down,
            hide, width, and remove controls, none of them routed through drag. */}
        <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
          <SortableContext items={sorted.map((b) => b.id)} strategy={verticalListSortingStrategy}>
            {sorted.map((block, index) => (
              <BillTabRow
                key={block.id}
                block={block}
                index={index}
                total={sorted.length}
                onMove={(direction) => onEdit(moveBlock(doc, block.id, direction))}
                onToggleVisible={() => onEdit(setBlockVisible(doc, block.id, !block.visible))}
                onSetWidth={(width) => onEdit(setBlockWidth(doc, block.id, width))}
                onRemove={() => onEdit(removeBlock(doc, block.id))}
              />
            ))}
          </SortableContext>
        </DndContext>
      </section>
    </div>
  );
}

interface BillTabRowProps {
  block: LayoutBlockV2;
  index: number;
  total: number;
  onMove: (direction: 'up' | 'down') => void;
  onToggleVisible: () => void;
  onSetWidth: (width: LayoutBlockV2['width']) => void;
  onRemove: () => void;
}

function BillTabRow({ block, index, total, onMove, onToggleVisible, onSetWidth, onRemove }: BillTabRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: block.id });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div ref={setNodeRef} style={style} className="bill-tab-row">
      {/* The drag handle is an ENHANCEMENT over the buttons beside it, not a
          replacement — every one of these buttons works with drag entirely absent. */}
      <span className="bill-tab-drag-handle" {...attributes} {...listeners} aria-label={`Drag to reorder ${block.type}`}>
        ⠿
      </span>
      <span className="bill-tab-row-type">{block.type}</span>

      <button type="button" onClick={() => onMove('up')} disabled={index === 0}>
        ↑
      </button>
      <button type="button" onClick={() => onMove('down')} disabled={index === total - 1}>
        ↓
      </button>

      <label>
        <input type="checkbox" checked={block.visible} onChange={onToggleVisible} />
        Visible
      </label>

      <select value={block.width} onChange={(e) => onSetWidth(e.target.value as LayoutBlockV2['width'])}>
        <option value="full">full</option>
        <option value="half">half</option>
        <option value="third">third</option>
      </select>

      <button type="button" onClick={onRemove}>
        Remove
      </button>
    </div>
  );
}
