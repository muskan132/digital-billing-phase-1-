import { generateIdentifier, IDENTIFIER_PATTERN } from './link-id.util';

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

describe('IDENTIFIER_PATTERN', () => {
  it('matches every identifier generateIdentifier() produces', () => {
    for (let i = 0; i < 1_000; i++) {
      expect(generateIdentifier()).toMatch(IDENTIFIER_PATTERN);
    }
  });

  it.each([
    ['too short', 'abc123'],
    ['too long', 'abcdefghijk1'],
    ['contains a slash (path-traversal-ish)', '../../etc12'],
    ['contains a dash', 'abcd-efghi'],
    ['empty string', ''],
  ])('rejects %s (%p)', (_label, input) => {
    expect(IDENTIFIER_PATTERN.test(input)).toBe(false);
  });
});
