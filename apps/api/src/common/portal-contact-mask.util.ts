// H-1 / D-58 / D-48: masking for the merchant-visible contact PROJECTION
// (GET /portal/bills' list DTO) — a distinct concern from mask.util.ts's
// maskMobile()/maskEmail(), which exist only to keep raw PII out of log
// lines and use a different (more aggressive) format. Never reuse or modify
// those for this purpose — D-48's literal example ("98****3210") is a
// public API contract, not a log convention, and the two must be free to
// diverge. Returns null (not a placeholder string) when the input is
// absent, matching JSON DTO semantics rather than log-line semantics.

// D-48 example: "98****3210" — first 2 digits, stars, last 4 digits. Below
// 7 characters there's no safe way to keep 2+4=6 digits without the mask
// revealing the whole number, so it's masked in full instead.
export function maskMobilePortal(mobile: string | undefined | null): string | null {
  if (!mobile) return null;
  if (mobile.length <= 6) return '*'.repeat(mobile.length);
  return mobile.slice(0, 2) + '*'.repeat(mobile.length - 6) + mobile.slice(-4);
}

// D-48 example: "a***@example.com" — first local-part character, stars,
// full domain (the domain alone isn't PII).
export function maskEmailPortal(email: string | undefined | null): string | null {
  if (!email) return null;
  const [local, domain] = email.split('@');
  if (!domain) return '*'.repeat(email.length);
  const maskedLocal = local.length <= 1 ? '*' : local[0] + '*'.repeat(local.length - 1);
  return `${maskedLocal}@${domain}`;
}

// H-3 / R-1: mask a Broadcast.recipient by its channel — EMAIL through the
// email mask, SMS (or anything else) through the mobile mask. The one place
// this dispatch lives; both PortalBillsService.findOne (H-3) and
// PortalDeliveriesService (R-1) import it, so the FAILED-delivery list and the
// bill-detail broadcasts list can never mask the same value two different ways.
export function maskBroadcastRecipient(channel: 'EMAIL' | 'SMS' | string, recipient: string): string | null {
  return channel === 'EMAIL' ? maskEmailPortal(recipient) : maskMobilePortal(recipient);
}
