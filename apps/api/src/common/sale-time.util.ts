// D-83: JioPay's raw callback datetime, strictly `yyyyMMddHHmmss` (14 digits, no
// separators). Interpreted as wall-clock time in a single named offset — IST has no
// DST, so a fixed numeric offset is exact, not an approximation — and converted to
// the UTC instant it represents. `IST_ZONE` is the one place that offset lives;
// nothing else in the codebase should hardcode it.
export const IST_ZONE = 330; // minutes, UTC+5:30

const RAW_PATTERN = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

// D-83/D-84: strictly 14 digits in yyyyMMddHHmmss, or null — never a coerced or
// guessed date. `offsetMinutes` defaults to IST_ZONE and exists as a parameter (not
// a hardcoded read of the module constant) so callers — and tests proving the offset
// is applied in exactly one place — can pass a different value without mutating the
// real exported constant.
export function parseSaleAt(raw: string | null | undefined, offsetMinutes: number = IST_ZONE): Date | null {
  if (!raw) return null;

  const match = RAW_PATTERN.exec(raw);
  if (!match) return null;

  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  const second = Number(secondStr);

  // D-83 addendum: a correctly-shaped but calendrically-impossible string (e.g. Feb
  // 31) must not silently overflow into a valid-looking wrong date. Date.UTC()
  // normalizes overflow instead of rejecting it, so round-trip the constructed
  // instant back through its own UTC getters and require an exact match.
  const wallClockUtcMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const wallClock = new Date(wallClockUtcMs);
  const roundTripsCleanly =
    wallClock.getUTCFullYear() === year &&
    wallClock.getUTCMonth() === month - 1 &&
    wallClock.getUTCDate() === day &&
    wallClock.getUTCHours() === hour &&
    wallClock.getUTCMinutes() === minute &&
    wallClock.getUTCSeconds() === second;
  if (!roundTripsCleanly) return null;

  return new Date(wallClockUtcMs - offsetMinutes * 60_000);
}
