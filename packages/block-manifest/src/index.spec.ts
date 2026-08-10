import { BLOCK_TYPES, BLOCK_MANIFEST, BlockType } from './index';

describe('BLOCK_MANIFEST internal consistency', () => {
  it('has exactly one entry per BLOCK_TYPES value, no more, no fewer', () => {
    const manifestKeys = Object.keys(BLOCK_MANIFEST).sort();
    const declaredTypes = [...BLOCK_TYPES].sort();
    expect(manifestKeys).toEqual(declaredTypes);
  });

  it.each(BLOCK_TYPES)('%s entry.type matches its own manifest key', (type) => {
    expect(BLOCK_MANIFEST[type].type).toBe(type);
  });

  it.each(BLOCK_TYPES)('%s entry.renderer is a non-empty string', (type) => {
    expect(typeof BLOCK_MANIFEST[type].renderer).toBe('string');
    expect(BLOCK_MANIFEST[type].renderer.length).toBeGreaterThan(0);
  });

  it('ITEMS is the only entry declaring bindableFields today', () => {
    const withBindableFields = BLOCK_TYPES.filter((t) => BLOCK_MANIFEST[t].bindableFields !== undefined);
    expect(withBindableFields).toEqual(['ITEMS']);
  });

  it('rejects an unknown type at the type level (compile-time guard)', () => {
    // @ts-expect-error - 'NOT_A_BLOCK' is not a BlockType; this line must fail
    // to compile if BlockType ever widens to `string`.
    const bad: BlockType = 'NOT_A_BLOCK';
    expect(bad).toBeDefined();
  });
});
