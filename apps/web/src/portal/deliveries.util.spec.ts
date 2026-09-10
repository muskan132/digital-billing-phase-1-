import { isPortalDeliveriesResponse, retryLabel } from './deliveries.util';

describe('retryLabel (D-7 / D-78)', () => {
  it('below the ceiling → retrying', () => {
    expect(retryLabel(2, 5)).toEqual({ text: '2/5 — retrying', exhausted: false });
  });
  it('at the ceiling → no longer retrying (given up)', () => {
    expect(retryLabel(5, 5)).toEqual({ text: '5/5 — no longer retrying', exhausted: true });
  });
  it('past the ceiling (env lowered after exhaustion) → still no longer retrying', () => {
    expect(retryLabel(5, 3)).toEqual({ text: '5/3 — no longer retrying', exhausted: true });
  });
});

describe('isPortalDeliveriesResponse', () => {
  const valid = {
    counts: { PENDING: 1, SENT: 2, FAILED: 3 },
    maxAttempts: 5,
    failed: [{ channel: 'EMAIL', status: 'FAILED', attempts: 5, sentAt: null, recipientMasked: 'a***@x.com', billId: 'b1' }],
  };

  it('accepts a well-formed payload', () => {
    expect(isPortalDeliveriesResponse(valid)).toBe(true);
  });

  it('accepts null billId / null recipientMasked', () => {
    expect(isPortalDeliveriesResponse({ ...valid, failed: [{ ...valid.failed[0], billId: null, recipientMasked: null }] })).toBe(true);
  });

  it('rejects a missing count, a missing maxAttempts, a non-array failed, a raw recipient key', () => {
    expect(isPortalDeliveriesResponse({ ...valid, counts: { PENDING: 1, SENT: 2 } })).toBe(false);
    expect(isPortalDeliveriesResponse({ counts: valid.counts, failed: [] })).toBe(false);
    expect(isPortalDeliveriesResponse({ ...valid, failed: 'nope' })).toBe(false);
    expect(isPortalDeliveriesResponse({ ...valid, failed: [{ attempts: 1 }] })).toBe(false);
  });
});
