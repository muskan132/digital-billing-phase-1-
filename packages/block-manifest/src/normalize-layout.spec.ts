import { normalizeToV2, LayoutBlockV1, LayoutSchemaV2 } from './normalize-layout';

const V1_DOC: LayoutBlockV1[] = [
  { type: 'HEADER', order: 1, props: {} },
  { type: 'MERCHANT_INFO', order: 2, props: {} },
  { type: 'ITEMS', order: 3, props: { columns: [] } },
  { type: 'TOTAL', order: 4, props: {} },
  { type: 'FOOTER', order: 5, props: {} },
];

describe('normalizeToV2', () => {
  it('upgrades a v1 array to the v2 envelope: schemaVersion 2, per-block id/visible/width, skeleton from the argument', () => {
    const result = normalizeToV2(V1_DOC, 'RETAIL');

    expect(result.schemaVersion).toBe(2);
    expect(result.skeleton).toBe('RETAIL');
    expect(result.theme).toBeUndefined();
    expect(result.blocks).toHaveLength(V1_DOC.length);
    result.blocks.forEach((block, i) => {
      expect(block.type).toBe(V1_DOC[i].type);
      expect(block.order).toBe(V1_DOC[i].order);
      expect(block.props).toBe(V1_DOC[i].props);
      expect(block.visible).toBe(true);
      expect(block.width).toBe('full');
      expect(block.id).toMatch(/^blk_[0-9a-z]+$/);
    });
  });

  it('does not emit a theme key at all (not even theme: undefined) — omission, not a defaulted value', () => {
    const result = normalizeToV2(V1_DOC, 'RETAIL');
    expect('theme' in result).toBe(false);
  });

  it('is idempotent: normalizing a v1 doc twice equals normalizing it once', () => {
    const once = normalizeToV2(V1_DOC, 'RETAIL');
    const twice = normalizeToV2(normalizeToV2(V1_DOC, 'RETAIL'), 'RETAIL');
    expect(twice).toEqual(once);
  });

  it('produces stable ids across repeated calls on the same input', () => {
    const first = normalizeToV2(V1_DOC, 'RETAIL');
    const second = normalizeToV2(V1_DOC, 'RETAIL');
    expect(second.blocks.map((b) => b.id)).toEqual(first.blocks.map((b) => b.id));
  });

  it('passes a v2 doc through unchanged (same reference, not a rebuilt equivalent)', () => {
    const v2Doc: LayoutSchemaV2 = {
      schemaVersion: 2,
      skeleton: 'RETAIL',
      theme: { accentHex: '#df9f3a', density: 'comfortable' },
      blocks: [{ id: 'blk_existing', type: 'HEADER', order: 1, props: {}, visible: true, width: 'full' }],
    };
    const result = normalizeToV2(v2Doc, 'RETAIL');
    expect(result).toBe(v2Doc);
  });

  it('sorts a shuffled v1 input array by order — every real seeded template (apps/api/prisma/seed.ts) is already sequential, so this is the one case neither the golden test nor real data would catch on its own', () => {
    const shuffled: LayoutBlockV1[] = [
      { type: 'FOOTER', order: 3, props: {} },
      { type: 'HEADER', order: 1, props: {} },
      { type: 'ITEMS', order: 2, props: {} },
    ];
    const result = normalizeToV2(shuffled, 'RETAIL');
    expect(result.blocks.map((b) => b.type)).toEqual(['HEADER', 'ITEMS', 'FOOTER']);
    expect(result.blocks.map((b) => b.order)).toEqual([1, 2, 3]);
  });

  it('does not mutate the input array while sorting', () => {
    const shuffled: LayoutBlockV1[] = [
      { type: 'FOOTER', order: 3, props: {} },
      { type: 'HEADER', order: 1, props: {} },
      { type: 'ITEMS', order: 2, props: {} },
    ];
    const inputTypesBefore = shuffled.map((b) => b.type);
    normalizeToV2(shuffled, 'RETAIL');
    expect(shuffled.map((b) => b.type)).toEqual(inputTypesBefore);
  });

  describe('id collision behavior (verified, not assumed)', () => {
    it('two blocks of the SAME type at DIFFERENT orders get distinct ids', () => {
      // None of the four seeded templates (apps/api/prisma/seed.ts) actually
      // has two blocks of the same type — checked directly, not assumed. This
      // is a synthetic case proving the algorithm doesn't depend on that
      // being true: it hashes `${type}:${order}`, so `order` alone is enough
      // to separate two same-type blocks.
      const doc: LayoutBlockV1[] = [
        { type: 'COUPON', order: 1, props: {} },
        { type: 'COUPON', order: 5, props: {} },
      ];
      const result = normalizeToV2(doc, 'RETAIL');
      expect(result.blocks[0].id).not.toBe(result.blocks[1].id);
    });

    it('two blocks sharing BOTH type and order DO collide — an already-invalid document this function does not validate', () => {
      // Deliberately malformed input (duplicate order is rejected by T-6's
      // future validateLayoutSchema, not by normalizeToV2). Asserting the
      // collision explicitly so it's a documented, tested property rather
      // than a silent gap.
      const doc: LayoutBlockV1[] = [
        { type: 'COUPON', order: 1, props: { code: 'A' } },
        { type: 'COUPON', order: 1, props: { code: 'B' } },
      ];
      const result = normalizeToV2(doc, 'RETAIL');
      expect(result.blocks[0].id).toBe(result.blocks[1].id);
    });
  });
});
