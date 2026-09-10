// R-1: pure helpers for the /portal/deliveries page, unit-tested without a
// browser (apps/web jest is node-env).

export interface PortalDeliveryFailedItem {
  channel: string;
  status: string;
  attempts: number;
  sentAt: string | null;
  recipientMasked: string | null;
  billId: string | null;
}

export interface PortalDeliveriesResponse {
  counts: { PENDING: number; SENT: number; FAILED: number };
  maxAttempts: number;
  failed: PortalDeliveryFailedItem[];
}

export function isPortalDeliveriesResponse(v: unknown): v is PortalDeliveriesResponse {
  if (typeof v !== 'object' || v === null) return false;
  const r = v as Record<string, unknown>;
  const c = r.counts as Record<string, unknown> | undefined;
  if (!c || typeof c.PENDING !== 'number' || typeof c.SENT !== 'number' || typeof c.FAILED !== 'number') return false;
  if (typeof r.maxAttempts !== 'number') return false;
  if (!Array.isArray(r.failed)) return false;
  return r.failed.every((f) => {
    if (typeof f !== 'object' || f === null) return false;
    const i = f as Record<string, unknown>;
    return (
      typeof i.channel === 'string' &&
      typeof i.status === 'string' &&
      typeof i.attempts === 'number' &&
      (i.sentAt === null || typeof i.sentAt === 'string') &&
      (i.recipientMasked === null || typeof i.recipientMasked === 'string') &&
      (i.billId === null || typeof i.billId === 'string')
    );
  });
}

// D-7 / D-78: the merchant-facing reading of `attempts` against the live
// ceiling. `attempts >= maxAttempts` means the drainer has permanently given
// up; below it means it is still on the retry schedule.
export function retryLabel(attempts: number, maxAttempts: number): { text: string; exhausted: boolean } {
  const exhausted = attempts >= maxAttempts;
  return {
    text: exhausted ? `${attempts}/${maxAttempts} — no longer retrying` : `${attempts}/${maxAttempts} — retrying`,
    exhausted,
  };
}
