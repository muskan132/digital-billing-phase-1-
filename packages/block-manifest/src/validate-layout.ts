// T-6: validateLayoutSchema — pure, shared, the ONLY definition (D-30) of what
// makes a v2 layoutSchema document safe to render. Consumed by C-2 (server-side
// gate on save) and U-5 (client-side live validation strip) — both import this,
// neither reimplements it.
//
// Scope: validates the layoutSchema DOCUMENT only (block types/order/ids/props).
// It does not see, and is not responsible for, the Template ROW's lineage fields
// (parentTemplateId/isHead/archivedAt) — those live outside this function's
// input entirely and are C-2's transactional concern (D-32), not this one's.
import type { BlockManifestEntry, BlockType } from './index';
import type { LayoutBlockV2, LayoutSchemaV2 } from './normalize-layout';

export interface Issue {
  severity: 'error';
  // Omitted for document-level issues (e.g. no visible HEADER at all) — there
  // is no single offending block to point at.
  blockId?: string;
  message: string;
}

export function validateLayoutSchema(doc: LayoutSchemaV2, manifest: Record<BlockType, BlockManifestEntry>): Issue[] {
  const issues: Issue[] = [];
  const visibleBlocks = doc.blocks.filter((b) => b.visible);

  // Rule: known types only.
  for (const block of doc.blocks) {
    if (!(block.type in manifest)) {
      issues.push({ severity: 'error', blockId: block.id, message: `Unknown block type "${block.type}"` });
    }
  }

  // Rule: HEADER + one of ITEMS/CHARGES present among visible blocks (D-31).
  // CHARGES is checked by literal type name — it has no manifest entry yet
  // (T-3's scope only covers block types actually rendered today; CHARGES is
  // reserved for the not-yet-built Utility/Public-sector template family,
  // TEMPLATE_SYSTEM_v2.md §4.3, where it replaces ITEMS entirely). So a
  // document using CHARGES will always separately fail the unknown-type rule
  // above even though it satisfies this presence check — expected today, not
  // a bug, and not a reason to special-case it here.
  if (!visibleBlocks.some((b) => b.type === 'HEADER')) {
    issues.push({ severity: 'error', message: 'A visible HEADER block is required' });
  }
  if (!visibleBlocks.some((b) => b.type === 'ITEMS' || b.type === 'CHARGES')) {
    issues.push({ severity: 'error', message: 'A visible ITEMS or CHARGES block is required' });
  }

  // Rule: order unique. First occurrence of a value is fine; each later block
  // sharing it is the offender.
  const seenOrders = new Set<number>();
  for (const block of doc.blocks) {
    if (seenOrders.has(block.order)) {
      issues.push({ severity: 'error', blockId: block.id, message: `Duplicate order ${block.order}` });
    } else {
      seenOrders.add(block.order);
    }
  }

  // Rule: block id unique. Same first-occurrence pattern as order.
  const seenIds = new Set<string>();
  for (const block of doc.blocks) {
    if (seenIds.has(block.id)) {
      issues.push({ severity: 'error', blockId: block.id, message: `Duplicate block id "${block.id}"` });
    } else {
      seenIds.add(block.id);
    }
  }

  // Rule: props valid against the manifest entry. Only checked for blocks with
  // a known type — an unknown type already has its own issue above and has no
  // manifest entry to validate props against.
  for (const block of doc.blocks) {
    const entry = manifest[block.type as BlockType];
    if (!entry) continue;
    issues.push(...validateProps(block, entry));
  }

  return issues;
}

function validateProps(block: LayoutBlockV2, entry: BlockManifestEntry): Issue[] {
  const issues: Issue[] = [];
  const props = block.props ?? {};

  for (const [propName, spec] of Object.entries(entry.props)) {
    const value = props[propName];

    if (value === undefined) {
      if (spec.required) {
        issues.push({ severity: 'error', blockId: block.id, message: `${block.type}: missing required prop "${propName}"` });
      }
      continue;
    }

    switch (spec.type) {
      case 'string':
        if (typeof value !== 'string') {
          issues.push({ severity: 'error', blockId: block.id, message: `${block.type}: prop "${propName}" must be a string` });
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          issues.push({ severity: 'error', blockId: block.id, message: `${block.type}: prop "${propName}" must be a boolean` });
        }
        break;
      case 'stringArray':
        if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
          issues.push({ severity: 'error', blockId: block.id, message: `${block.type}: prop "${propName}" must be an array of strings` });
        }
        break;
      case 'columns':
        issues.push(...validateColumns(block, propName, value, entry));
        break;
    }
  }

  return issues;
}

function validateColumns(block: LayoutBlockV2, propName: string, value: unknown, entry: BlockManifestEntry): Issue[] {
  if (!Array.isArray(value)) {
    return [{ severity: 'error', blockId: block.id, message: `${block.type}: prop "${propName}" must be an array` }];
  }

  const issues: Issue[] = [];
  const bindable = entry.bindableFields ?? [];
  for (const column of value) {
    if (typeof column !== 'object' || column === null) {
      issues.push({ severity: 'error', blockId: block.id, message: `${block.type}: "${propName}" entries must be objects` });
      continue;
    }
    const col = column as Record<string, unknown>;
    if (typeof col.field !== 'string' || !bindable.includes(col.field)) {
      issues.push({ severity: 'error', blockId: block.id, message: `${block.type}: "${propName}" column has an invalid field "${String(col.field)}"` });
    }
    if (typeof col.label !== 'string') {
      issues.push({ severity: 'error', blockId: block.id, message: `${block.type}: "${propName}" column is missing a string label` });
    }
    if (typeof col.visible !== 'boolean') {
      issues.push({ severity: 'error', blockId: block.id, message: `${block.type}: "${propName}" column is missing a boolean visible` });
    }
  }
  return issues;
}
