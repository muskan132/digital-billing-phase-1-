import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PortalDeliveriesService } from './portal-deliveries.service';

const MERCHANT_ID = 'merchant-A';
const RAW_MOBILE = '9876543210';
const RAW_EMAIL = 'anna@example.com';

function failedRow(overrides: Record<string, unknown> = {}) {
  return {
    channel: 'EMAIL',
    status: 'FAILED',
    attempts: 5,
    sentAt: null,
    recipient: RAW_EMAIL,
    order: { bill: { id: 'bill-1' } },
    ...overrides,
  };
}

function makeService(opts: { grouped?: unknown[]; failed?: unknown[] } = {}) {
  const groupBy = jest.fn().mockResolvedValue(opts.grouped ?? []);
  const findMany = jest.fn().mockResolvedValue(opts.failed ?? []);
  const service = new PortalDeliveriesService({ broadcast: { groupBy, findMany } } as unknown as PrismaService);
  return { service, groupBy, findMany };
}

describe('PortalDeliveriesService.getDeliveries — counts', () => {
  it('zero-fills every BroadcastStatus when groupBy returns only some', async () => {
    const { service } = makeService({ grouped: [{ status: 'SENT', _count: { _all: 12 } }] });
    const result = await service.getDeliveries(MERCHANT_ID);
    expect(result.counts).toEqual({ PENDING: 0, SENT: 12, FAILED: 0 });
  });

  it('passes every status count through unchanged', async () => {
    const { service } = makeService({
      grouped: [
        { status: 'PENDING', _count: { _all: 3 } },
        { status: 'SENT', _count: { _all: 40 } },
        { status: 'FAILED', _count: { _all: 2 } },
      ],
    });
    const result = await service.getDeliveries(MERCHANT_ID);
    expect(result.counts).toEqual({ PENDING: 3, SENT: 40, FAILED: 2 });
  });

  it('scopes both queries through the Broadcast -> Order -> merchantId relation filter', async () => {
    const { service, groupBy, findMany } = makeService();
    await service.getDeliveries(MERCHANT_ID);
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ by: ['status'], where: { order: { merchantId: MERCHANT_ID } } }),
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { status: 'FAILED', order: { merchantId: MERCHANT_ID } } }),
    );
  });
});

describe('PortalDeliveriesService.getDeliveries — maxAttempts (D-78 / MAJOR-1)', () => {
  const original = process.env.MAX_BROADCAST_ATTEMPTS;
  afterEach(() => {
    if (original === undefined) delete process.env.MAX_BROADCAST_ATTEMPTS;
    else process.env.MAX_BROADCAST_ATTEMPTS = original;
  });

  it('is a TOP-LEVEL field, default 5, not attached to any failed item', async () => {
    delete process.env.MAX_BROADCAST_ATTEMPTS;
    const { service } = makeService({ failed: [failedRow()] });
    const result = await service.getDeliveries(MERCHANT_ID);
    expect(result.maxAttempts).toBe(5);
    expect(result.failed[0]).not.toHaveProperty('maxAttempts');
  });

  it('reflects the MAX_BROADCAST_ATTEMPTS env — the same source the drainer uses', async () => {
    process.env.MAX_BROADCAST_ATTEMPTS = '3';
    const { service } = makeService();
    expect((await service.getDeliveries(MERCHANT_ID)).maxAttempts).toBe(3);
  });
});

describe('PortalDeliveriesService.getDeliveries — FAILED item whitelist (D-48 + D-78)', () => {
  it('emits EXACTLY six keys — D-48 five contact fields + billId, nothing else', async () => {
    const { service } = makeService({ failed: [failedRow()] });
    const item = (await service.getDeliveries(MERCHANT_ID)).failed[0];
    expect(Object.keys(item).sort()).toEqual(
      ['attempts', 'billId', 'channel', 'recipientMasked', 'sentAt', 'status'].sort(),
    );
    for (const banned of ['recipient', 'error', 'id', 'orderId', 'order', 'createdAt', 'updatedAt']) {
      expect(item).not.toHaveProperty(banned);
    }
  });

  it('masks recipient by channel — EMAIL via the email mask, SMS via the mobile mask — and never emits the raw value', async () => {
    const { service } = makeService({
      failed: [
        failedRow({ channel: 'EMAIL', recipient: RAW_EMAIL }),
        failedRow({ channel: 'SMS', recipient: RAW_MOBILE, order: { bill: null } }),
      ],
    });
    const { failed } = await service.getDeliveries(MERCHANT_ID);
    expect(failed[0].recipientMasked).toBe('a***@example.com');
    expect(failed[1].recipientMasked).toBe('98****3210');
    const serialized = JSON.stringify(failed);
    expect(serialized).not.toContain(RAW_EMAIL);
    expect(serialized).not.toContain(RAW_MOBILE);
  });

  it('billId comes from order.bill.id, or null when the order has no bill', async () => {
    const { service } = makeService({
      failed: [failedRow({ order: { bill: { id: 'bill-9' } } }), failedRow({ order: { bill: null } })],
    });
    const { failed } = await service.getDeliveries(MERCHANT_ID);
    expect(failed[0].billId).toBe('bill-9');
    expect(failed[1].billId).toBeNull();
  });

  it('sentAt is null for a FAILED row (kept because D-48 lists it)', async () => {
    const { service } = makeService({ failed: [failedRow({ sentAt: null })] });
    expect((await service.getDeliveries(MERCHANT_ID)).failed[0].sentAt).toBeNull();
  });

  it('caps the FAILED list at 200 rows (take: 200) — no pagination', async () => {
    const { service, findMany } = makeService();
    await service.getDeliveries(MERCHANT_ID);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 200, orderBy: { createdAt: 'desc' } }));
  });

  it('the select carries no `error` column and no bare `recipient` in the DTO', async () => {
    const { service, findMany } = makeService();
    await service.getDeliveries(MERCHANT_ID);
    const select = (findMany.mock.calls[0][0] as { select: Record<string, unknown> }).select;
    expect(select).not.toHaveProperty('error');
    // recipient IS selected (it must be, to mask it) but never reaches the DTO — covered above.
    expect(select.recipient).toBe(true);
  });
});

describe('PortalDeliveriesService — logging deny-test (R-1 / D-48 "never logged")', () => {
  it('the service file has no Logger and no console call at all', () => {
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const source = fs.readFileSync(path.join(__dirname, 'portal-deliveries.service.ts'), 'utf8');
    expect(source).not.toMatch(/Logger|console\./);
  });

  it('a real getDeliveries call never puts the raw recipient through console.log/warn/error', async () => {
    const { service } = makeService({
      failed: [failedRow({ channel: 'EMAIL', recipient: RAW_EMAIL }), failedRow({ channel: 'SMS', recipient: RAW_MOBILE })],
    });
    const spies = [jest.spyOn(console, 'log'), jest.spyOn(console, 'warn'), jest.spyOn(console, 'error')];
    try {
      const result = await service.getDeliveries(MERCHANT_ID);
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(RAW_EMAIL);
          expect(JSON.stringify(call)).not.toContain(RAW_MOBILE);
        }
      }
      expect(JSON.stringify(result)).not.toContain(RAW_EMAIL);
      expect(JSON.stringify(result)).not.toContain(RAW_MOBILE);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

// ---- R-2 / D-69 / D-79: resend ------------------------------------------
const D = (iso: string) => new Date(iso);

function makeResendService(bill: unknown) {
  const findFirst = jest.fn().mockResolvedValue(bill);
  const create = jest.fn().mockResolvedValue({ id: 'new-broadcast' });
  const tx = { bill: { findFirst }, broadcast: { create } };
  const $transaction = jest.fn().mockImplementation((cb: (t: unknown) => unknown) => cb(tx));
  const service = new PortalDeliveriesService({ $transaction } as unknown as PrismaService);
  return { service, findFirst, create };
}

function billWith(broadcasts: Array<Record<string, unknown>>) {
  return { order: { id: 'order-1', broadcasts } };
}

describe('PortalDeliveriesService.resend (R-2)', () => {
  it('creates ONE new PENDING/attempts:0 row copying channel + STORED recipient from the FAILED row; returns { resent, channel }', async () => {
    const { service, create } = makeResendService(
      billWith([{ channel: 'EMAIL', recipient: RAW_EMAIL, status: 'FAILED', createdAt: D('2026-09-01T00:00:00Z') }]),
    );

    const result = await service.resend(MERCHANT_ID, 'bill-1');

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: { orderId: 'order-1', channel: 'EMAIL', recipient: RAW_EMAIL, status: 'PENDING', attempts: 0 },
    });
    expect(result).toEqual({ resent: true, channel: 'EMAIL' });
    // deny: response body carries no recipient at all
    expect(JSON.stringify(result)).not.toContain(RAW_EMAIL);
  });

  it('the new row matches the drainer candidate query — status PENDING (first branch), attempts 0 (backoff-exempt)', async () => {
    const { service, create } = makeResendService(
      billWith([{ channel: 'SMS', recipient: RAW_MOBILE, status: 'FAILED', createdAt: D('2026-09-01T00:00:00Z') }]),
    );
    await service.resend(MERCHANT_ID, 'bill-1');
    const data = (create.mock.calls[0][0] as { data: Record<string, unknown> }).data;
    expect(data.status).toBe('PENDING');
    expect(data.attempts).toBe(0);
  });

  it('targets the MOST-RECENT FAILED row when there are several (all same destination in practice)', async () => {
    const { service, create } = makeResendService(
      billWith([
        { channel: 'EMAIL', recipient: 'old@example.com', status: 'FAILED', createdAt: D('2026-09-01T00:00:00Z') },
        { channel: 'EMAIL', recipient: 'newest@example.com', status: 'FAILED', createdAt: D('2026-09-03T00:00:00Z') },
        { channel: 'EMAIL', recipient: 'mid@example.com', status: 'FAILED', createdAt: D('2026-09-02T00:00:00Z') },
      ]),
    );
    await service.resend(MERCHANT_ID, 'bill-1');
    expect((create.mock.calls[0][0] as { data: { recipient: string } }).data.recipient).toBe('newest@example.com');
  });

  it('attempts count is NOT a gate — a FAILED row well below maxAttempts still resends (D-79 NIT-2)', async () => {
    const { service, create } = makeResendService(
      billWith([{ channel: 'EMAIL', recipient: RAW_EMAIL, status: 'FAILED', attempts: 1, createdAt: D('2026-09-01T00:00:00Z') }]),
    );
    await service.resend(MERCHANT_ID, 'bill-1');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('refuses with 422 RESEND_ALREADY_PENDING while ANY PENDING exists for the order — no create', async () => {
    const { service, create } = makeResendService(
      billWith([
        { channel: 'SMS', recipient: RAW_MOBILE, status: 'PENDING', createdAt: D('2026-09-02T00:00:00Z') },
        { channel: 'EMAIL', recipient: RAW_EMAIL, status: 'FAILED', createdAt: D('2026-09-01T00:00:00Z') },
      ]),
    );
    const err = await service.resend(MERCHANT_ID, 'bill-1').catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ error_code: 'RESEND_ALREADY_PENDING' });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses with 422 NO_FAILED_BROADCAST when only SENT broadcasts exist — no create', async () => {
    const { service, create } = makeResendService(
      billWith([{ channel: 'EMAIL', recipient: RAW_EMAIL, status: 'SENT', createdAt: D('2026-09-01T00:00:00Z') }]),
    );
    const err = await service.resend(MERCHANT_ID, 'bill-1').catch((e) => e);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ error_code: 'NO_FAILED_BROADCAST' });
    expect(create).not.toHaveBeenCalled();
  });

  it('refuses with 422 NO_FAILED_BROADCAST when there are no broadcasts at all', async () => {
    const { service } = makeResendService(billWith([]));
    const err = await service.resend(MERCHANT_ID, 'bill-1').catch((e) => e);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ error_code: 'NO_FAILED_BROADCAST' });
  });

  it('404 (NotFoundException) when the bill is not this merchant\'s / does not exist — no create', async () => {
    const { service, findFirst, create } = makeResendService(null);
    await expect(service.resend(MERCHANT_ID, 'nope')).rejects.toBeInstanceOf(NotFoundException);
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'nope', merchantId: MERCHANT_ID } }));
    expect(create).not.toHaveBeenCalled();
  });

  it('maps the partial-index P2002 (concurrent double-click) to the SAME 422 RESEND_ALREADY_PENDING', async () => {
    const { service, create } = makeResendService(
      billWith([{ channel: 'EMAIL', recipient: RAW_EMAIL, status: 'FAILED', createdAt: D('2026-09-01T00:00:00Z') }]),
    );
    create.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('unique', { code: 'P2002', clientVersion: 't', meta: { target: 'Broadcast_orderId_pending_key' } }),
    );
    const err = await service.resend(MERCHANT_ID, 'bill-1').catch((e) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ error_code: 'RESEND_ALREADY_PENDING' });
  });
});
