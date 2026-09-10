// D-7: the retry ceiling for the broadcast drainer. A `FAILED` broadcast whose
// `attempts` has reached this value is permanently given up — the drainer's
// candidate query (`attempts: { lt: maxAttempts }`) excludes it and it is never
// retried again.
//
// Extracted from broadcast-drainer.service.ts (R-1 / D-78) so `GET
// /portal/deliveries` can report the SAME ceiling the drainer enforces. The
// merchant's "3/5 — still retrying" vs "5/5 — no longer retrying" reading is
// only correct if this number cannot drift between the two call sites.
//
// A bad env value fails loudly on first call rather than silently computing
// NaN/0 and disabling retries with no log line.
export const DEFAULT_MAX_BROADCAST_ATTEMPTS = 5;

export function resolveMaxBroadcastAttempts(): number {
  const raw = process.env.MAX_BROADCAST_ATTEMPTS;
  if (raw === undefined) return DEFAULT_MAX_BROADCAST_ATTEMPTS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`MAX_BROADCAST_ATTEMPTS must be a positive integer, got: "${raw}"`);
  }
  return parsed;
}
