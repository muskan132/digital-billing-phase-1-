import { formatPaise, formatMoney } from './money-format';
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

describe('formatMoney', () => {
  it('prefixes the currency symbol for known currencies', () => {
    expect(formatMoney('100', 'INR')).toBe('₹1.00');
  });

  it('falls back to the currency code for unknown currencies', () => {
    expect(formatMoney('100', 'USD')).toBe('USD 1.00');
  });

  it('passes the AMOUNT_UNAVAILABLE marker through unchanged, without a currency prefix', () => {
    expect(formatMoney(AMOUNT_UNAVAILABLE, 'INR')).toBe(AMOUNT_UNAVAILABLE);
  });
});
