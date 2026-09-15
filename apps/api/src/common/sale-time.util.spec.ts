import { parseSaleAt, IST_ZONE } from './sale-time.util';

describe('parseSaleAt', () => {
  it('parses a 14-digit yyyyMMddHHmmss value to the expected UTC instant', () => {
    // 2026-09-16 14:00:00 IST == 2026-09-16 08:30:00 UTC
    expect(parseSaleAt('20260916140000')).toEqual(new Date('2026-09-16T08:30:00.000Z'));
  });

  it("roadmap's own example: a 23:30 IST value lands on the correct calendar day (same UTC day here)", () => {
    // 2026-09-16 23:30:00 IST == 2026-09-16 18:00:00 UTC — no rollover in this direction.
    expect(parseSaleAt('20260916233000')).toEqual(new Date('2026-09-16T18:00:00.000Z'));
  });

  it('genuine day-boundary case: an early-morning IST value rolls back to the PREVIOUS calendar day in UTC', () => {
    // 2026-09-16 00:30:00 IST == 2026-09-15 19:00:00 UTC — proves the rollover
    // direction, which the 23:30 example alone does not.
    const result = parseSaleAt('20260916003000');
    expect(result).toEqual(new Date('2026-09-15T19:00:00.000Z'));
    expect(result?.getUTCDate()).toBe(15);
  });

  it.each([
    ['1234567890123', '13 digits'],
    ['123456789012345', '15 digits'],
    ['2026091614000a', 'trailing non-numeric character'],
    ['abcdefghijklmn', 'entirely non-numeric'],
    ['', 'empty string'],
  ])('yields null, never a coerced date, for %s (%s)', (raw) => {
    expect(parseSaleAt(raw)).toBeNull();
  });

  it('yields null for null/undefined input', () => {
    expect(parseSaleAt(null)).toBeNull();
    expect(parseSaleAt(undefined)).toBeNull();
  });

  // D-83 addendum: correctly-shaped (14 digits, yyyyMMddHHmmss) but calendrically
  // impossible — must not silently overflow into a valid-looking wrong date.
  it.each([
    ['20260231235959', 'Feb 31 (no such day)'],
    ['20261316000000', 'month 13'],
    ['20260916250000', 'hour 25'],
    ['20260916146000', 'minute 60'],
    ['20260916140060', 'second 60'],
  ])('yields null for calendrically-invalid %s (%s), not an overflowed date', (raw) => {
    expect(parseSaleAt(raw)).toBeNull();
  });

  it('IST_ZONE is 330 minutes (UTC+5:30, no DST)', () => {
    expect(IST_ZONE).toBe(330);
  });

  // Proves the offset is applied in exactly one arithmetic place: passing a
  // different offset (without touching the real IST_ZONE constant) produces a
  // uniformly shifted result relative to the default.
  it('changing the offset parameter shifts the result uniformly, proving the interpretation lives in one place', () => {
    const raw = '20260916140000';
    const atIstOffset = parseSaleAt(raw, IST_ZONE);
    const atUtcOffset = parseSaleAt(raw, 0);
    const atMinusOneHour = parseSaleAt(raw, -60);

    expect(atIstOffset).toEqual(new Date('2026-09-16T08:30:00.000Z'));
    expect(atUtcOffset).toEqual(new Date('2026-09-16T14:00:00.000Z'));
    expect(atMinusOneHour).toEqual(new Date('2026-09-16T15:00:00.000Z'));

    // Every offset change shifts the SAME wall-clock reading by exactly its own
    // delta from IST_ZONE — a single shared arithmetic path, not per-branch logic.
    expect(atUtcOffset!.getTime() - atIstOffset!.getTime()).toBe(IST_ZONE * 60_000);
    expect(atMinusOneHour!.getTime() - atIstOffset!.getTime()).toBe((IST_ZONE - -60) * 60_000);
  });
});
