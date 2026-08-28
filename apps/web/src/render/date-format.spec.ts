import { formatCallbackDateTime, formatUtcTimestamp } from './date-format';

describe('formatCallbackDateTime', () => {
  it.each([
    ['20260717120000', '17 Jul 2026, 12:00 PM'],
    ['20260717000000', '17 Jul 2026, 12:00 AM'],
    ['20260717093005', '17 Jul 2026, 9:30 AM'],
    ['20250910123438', '10 Sep 2025, 12:34 PM'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatCallbackDateTime(input)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['not-a-date'],
    ['2026071712'], // too short
    ['202607171200001'], // too long
    ['20261317120000'], // month 13
  ])('returns null for %s', (input) => {
    expect(formatCallbackDateTime(input)).toBeNull();
  });
});

describe('formatUtcTimestamp (H-2)', () => {
  it.each([
    ['2026-07-17T12:00:00.000Z', '17 Jul 2026, 12:00 PM UTC'],
    ['2026-07-17T00:00:00.000Z', '17 Jul 2026, 12:00 AM UTC'],
    ['2026-07-17T09:30:05.000Z', '17 Jul 2026, 9:30 AM UTC'],
  ])('formats %s as %s', (input, expected) => {
    expect(formatUtcTimestamp(input)).toBe(expected);
  });

  it('renders in UTC regardless of the input timezone offset', () => {
    // 11 PM IST (UTC+5:30) on the 17th is 5:30 PM UTC the same day.
    expect(formatUtcTimestamp('2026-07-17T23:00:00+05:30')).toBe('17 Jul 2026, 5:30 PM UTC');
  });

  it('returns null for malformed input', () => {
    expect(formatUtcTimestamp('not-a-date')).toBeNull();
  });
});
