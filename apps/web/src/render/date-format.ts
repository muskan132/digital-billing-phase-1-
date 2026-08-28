const RAW_PATTERN = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/;

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

// Parses JioPay's raw "yyyyMMddHHmmss" callback datetime into a human-readable string.
// Returns null on missing/malformed input so callers can omit the line entirely rather
// than show a raw or garbled date.
export function formatCallbackDateTime(raw: string | null | undefined): string | null {
  if (!raw) return null;

  const match = RAW_PATTERN.exec(raw);
  if (!match) return null;

  const [, year, month, day, hours, minutes] = match;
  const monthIndex = Number(month) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;

  const hour24 = Number(hours);
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  return `${Number(day)} ${MONTHS[monthIndex]} ${year}, ${hour12}:${minutes} ${period}`;
}

// H-2: formats an ISO 8601 timestamp (e.g. Bill.createdAt) as UTC, explicitly
// — never the viewer's local timezone, which would make "same list, same
// order" depend on where the merchant happens to be sitting. Uses the
// Date object's own UTC getters, never Number()/parseFloat() on the string.
export function formatUtcTimestamp(iso: string): string | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;

  const day = date.getUTCDate();
  const month = MONTHS[date.getUTCMonth()];
  const year = date.getUTCFullYear();
  const hour24 = date.getUTCHours();
  const minutes = date.getUTCMinutes().toString().padStart(2, '0');
  const period = hour24 >= 12 ? 'PM' : 'AM';
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;

  return `${day} ${month} ${year}, ${hour12}:${minutes} ${period} UTC`;
}
