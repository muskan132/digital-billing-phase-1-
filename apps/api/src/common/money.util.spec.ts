import { rupeesToPaise } from './money.util';

describe('rupeesToPaise', () => {
  it.each([
    ['1.00', 100n],
    ['0.01', 1n],
    ['1000000.00', 100000000n],
    ['0.00', 0n],
  ])('parses %s to %s paise', (input, expected) => {
    expect(rupeesToPaise(input)).toBe(expected);
  });

  it.each([
    ['1.005'],
    ['1000'],
    ['0'],
    ['-5.00'],
    ['abc'],
  ])('throws for %s', (input) => {
    expect(() => rupeesToPaise(input)).toThrow();
  });
});
