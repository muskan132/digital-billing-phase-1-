import { maskEmail, maskMobile } from './mask.util';

// D-94: detecting a PII-shaped substring inside free-form text (a Prisma
// error's message/stack/meta) is a different operation from masking a
// known-channel value, and is genuinely new code — the star-out algorithm
// itself is never reimplemented here, only located and delegated to
// maskMobile/maskEmail. Emails are scrubbed first: an email's local part
// can itself contain a 10-digit run, and scrubbing it first (replacing it
// with its already-masked form) prevents the mobile regex from tripping on
// digits inside an email address.
const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const MOBILE_PATTERN = /\b\d{10}\b/g;

export function scrubPiiFromText(text: string): string {
  return text.replace(EMAIL_PATTERN, (match) => maskEmail(match)).replace(MOBILE_PATTERN, (match) => maskMobile(match));
}

// Prisma's `meta` shape is not guaranteed stable across error codes/Prisma
// versions (D-94) — this walks whatever shape shows up rather than
// hardcoding known keys like `target`/`message`, so a string value nested
// anywhere is still scrubbed.
export function scrubPiiDeep(value: unknown): unknown {
  if (typeof value === 'string') {
    return scrubPiiFromText(value);
  }
  if (Array.isArray(value)) {
    return value.map(scrubPiiDeep);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = scrubPiiDeep(val);
    }
    return out;
  }
  return value;
}
