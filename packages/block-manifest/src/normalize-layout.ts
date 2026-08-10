// T-4: pure v1 -> v2 layoutSchema normalizer (D-29). No I/O, no randomness —
// every id/shape decision here is a deterministic function of the input.
//
// v1 shape (undocumented as a type until now, but this is exactly what
// apps/api/prisma/seed.ts and apps/web's LayoutBlock interface already use):
// a bare ordered array of { type, order, props }.
export interface LayoutBlockV1 {
  type: string;
  order: number;
  props: Record<string, unknown>;
}

// v2 shape per TEMPLATE_SYSTEM_v2.md §2.
export interface LayoutBlockV2 extends LayoutBlockV1 {
  id: string;
  visible: boolean;
  width: 'full' | 'half' | 'third';
}

export interface LayoutThemeV2 {
  accentHex: string;
  density: string;
}

export interface LayoutSchemaV2 {
  schemaVersion: 2;
  skeleton: string;
  // Optional, NOT defaulted here. v1 templates carry no theme data anywhere
  // in the current schema/seed data, and inventing a default accent color
  // would be fabricating a value with no source — a separate future
  // decision, not this normalizer's to make. A v2 doc with no `theme` key
  // is the correct, honest output until a real value exists.
  theme?: LayoutThemeV2;
  blocks: LayoutBlockV2[];
}

export type LayoutSchemaDoc = LayoutBlockV1[] | LayoutSchemaV2;

function isV2(doc: LayoutSchemaDoc): doc is LayoutSchemaV2 {
  return !Array.isArray(doc) && (doc as LayoutSchemaV2).schemaVersion === 2;
}

// FNV-1a, 32-bit. Chosen for T-4 (not documented anywhere prior to this) to
// satisfy exactly three required properties: deterministic (pure function of
// the input string), idempotent (re-running normalizeToV2 on its own v1
// input reproduces the same ids), and stable across runs (no per-process
// seed/counter state). Not a security hash — collision resistance only
// needs to hold across the handful of blocks in one template, not
// adversarial input.
function fnv1a(str: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// Keyed on `${type}:${order}`, NOT `type` alone — order is what's actually
// guaranteed unique within a template (D-1's implicit assumption, made an
// explicit rule by T-6 later). Two blocks of the same type at different
// orders hash differently because `order` differs, even though `type`
// repeats — verified directly in normalize-layout.spec.ts, not just assumed.
// Two blocks sharing both `type` AND `order` WOULD collide, but that pair is
// already an invalid document (duplicate order) — this function does not
// validate; T-6's validateLayoutSchema is where that gets rejected.
// Full 32-bit hash space is kept (no truncation) to avoid manufacturing a
// collision risk that fnv1a's own output didn't have.
function generateBlockId(type: string, order: number): string {
  const hash = fnv1a(`${type}:${order}`);
  return `blk_${hash.toString(36).padStart(7, '0')}`;
}

export function normalizeToV2(doc: LayoutSchemaDoc, skeleton: string): LayoutSchemaV2 {
  if (isV2(doc)) {
    // Passthrough, not a rebuild — a v2 doc must come back byte-identical,
    // not merely equivalent. Returning the same reference (no spread, no
    // JSON round-trip) is what guarantees that.
    return doc;
  }

  return {
    schemaVersion: 2,
    skeleton,
    // Sorted by `order`, not left in input array order — §2 treats `order`
    // as authoritative and array position as non-identity, but the
    // normalizer's job is to produce a canonical v2 document, and a stored
    // document whose array position disagrees with its own `order` field is
    // not normalized, just relabeled. renderTemplate re-sorting at render
    // time doesn't excuse this: other future consumers (the builder's BILL
    // tab, T-5's migration script) may read `blocks[]` positionally.
    // .slice() before .sort() — never mutate the input array.
    blocks: doc
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((block) => ({
        type: block.type,
        order: block.order,
        props: block.props,
        id: generateBlockId(block.type, block.order),
        visible: true,
        width: 'full',
      })),
  };
}
