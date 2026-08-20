'use client';

// Split-view redesign (post-X-2): the left panel of the merged editor. Owns the
// palette and the DndContext/SortableContext (D-36, unchanged from BillTab.tsx) —
// every mutation, drag OR button, still funnels through the same patch-helpers
// functions. BlockCard owns each block's combined layout+prop-editor section.
import { DndContext, DragEndEvent, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { BLOCK_MANIFEST, BlockType, LayoutSchemaV2 } from '@digital-billing/block-manifest';
import { addBlock, reorderBlockToPosition } from './patch-helpers';
import { BlockCard } from './BlockCard';

export interface EditBillPanelProps {
  doc: LayoutSchemaV2;
  onEdit: (doc: LayoutSchemaV2) => void;
  onEditDebounced: (doc: LayoutSchemaV2) => void;
}

export function EditBillPanel({ doc, onEdit, onEditDebounced }: EditBillPanelProps) {
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
    <div className="edit-bill-panel">
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

      {/* Drag disabled entirely (JS off, or DndContext removed) still leaves a
          fully operable list — every card below has its own move-up/move-down,
          hide, width, and remove controls, none of them routed through drag. */}
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        <SortableContext items={sorted.map((b) => b.id)} strategy={verticalListSortingStrategy}>
          <div className="edit-bill-blocks">
            {sorted.map((block, index) => (
              <BlockCard
                key={block.id}
                block={block}
                index={index}
                total={sorted.length}
                doc={doc}
                onEdit={onEdit}
                onEditDebounced={onEditDebounced}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}
