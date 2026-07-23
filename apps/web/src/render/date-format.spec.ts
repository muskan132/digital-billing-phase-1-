import { formatCallbackDateTime } from './date-format';

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
