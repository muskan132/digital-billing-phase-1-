import { formatPaise } from './money-format';
import { AMOUNT_UNAVAILABLE } from './template-renderer';

describe('formatPaise', () => {
  it.each([
    ['100', '1.00'],
    ['1', '0.01'],
    ['100000000', '1000000.00'],
    ['0', '0.00'],
    ['-500', '-5.00'],
  ])('formats %s paise as %s', (input, expected) => {
    expect(formatPaise(input)).toBe(expected);
  });

  it('passes the AMOUNT_UNAVAILABLE marker through unchanged', () => {
    expect(formatPaise(AMOUNT_UNAVAILABLE)).toBe(AMOUNT_UNAVAILABLE);
  });

  it('passes non-numeric input through unchanged rather than coercing it', () => {
    expect(formatPaise('abc')).toBe('abc');
  });
});
