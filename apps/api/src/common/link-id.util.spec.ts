import { generateIdentifier } from './link-id.util';

describe('generateIdentifier', () => {
  it('generates URL-safe, unique identifiers across many calls', () => {
    const count = 10_000;
    const ids = new Set<string>();

    for (let i = 0; i < count; i++) {
      const id = generateIdentifier();
      expect(id).toMatch(/^[0-9A-Za-z]{10}$/);
      ids.add(id);
    }

    expect(ids.size).toBe(count);
  });
});
