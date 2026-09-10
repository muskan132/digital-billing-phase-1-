// R-1 / D-78: real-Postgres coverage for the two guarantees a mocked
// PrismaService cannot prove —
//   1. the status counts reconcile EXACTLY to a hand-written GROUP BY over the
//      Broadcast -> Order join (not the Prisma query builder checking itself).
//   2. cross-merchant isolation, cross-checked against a direct SELECT: a
//      second merchant's broadcasts appear in neither the counts nor the list.
// Plus: D-7-exhausted rows are visible; the raw recipient never leaves the
// serializer; the 200-row cap holds.
import { BroadcastStatus, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { maskEmailPortal } from '../common/portal-contact-mask.util';
import { PortalDeliveriesService } from './portal-deliveries.service';

const prisma = new PrismaClient();
const service = new PortalDeliveriesService(prisma as unknown as PrismaService);

let counter = 0;
const uid = (p: string) => `r1-itest-${p}-${Date.now()}-${++counter}`;

interface Scratch {
  merchantId: string;
  templateId: string;
}

async function createScratchMerchant(): Promise<Scratch> {
  const merchantId = uid('merchant');
  await prisma.merchant.create({
    data: { id: merchantId, jiopayMid: uid('mid'), name: `R-1 itest ${merchantId}`, secretKeyEnc: Buffer.from('unused') },
  });
  const templateId = uid('template');
  await prisma.template.create({
    data: { id: templateId, merchantId, name: `R-1 itest template ${templateId}`, billType: 'RECEIPT', layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] }, isHead: true },
  });
  return { merchantId, templateId };
}

async function createOrder(m: Scratch, withBill = false): Promise<string> {
  const orderId = uid('order');
  await prisma.order.create({ data: { id: orderId, merchantId: m.merchantId, status: 'SUCCESS', externalTransactionId: uid('ext'), rawCallback: {} } });
  if (withBill) {
    await prisma.bill.create({ data: { id: uid('bill'), orderId, merchantId: m.merchantId, billType: 'RECEIPT', templateId: m.templateId, totalPaise: 100n, snapshot: {} } });
  }
  return orderId;
}

async function addBroadcast(
  orderId: string,
  opts: { status: BroadcastStatus; channel?: 'EMAIL' | 'SMS'; recipient?: string; attempts?: number },
) {
  await prisma.broadcast.create({
    data: {
      orderId,
      channel: opts.channel ?? 'EMAIL',
      recipient: opts.recipient ?? 'someone@example.com',
      status: opts.status,
      attempts: opts.attempts ?? 0,
      ...(opts.status === 'SENT' ? { sentAt: new Date() } : {}),
    },
  });
}

async function cleanup(m: Scratch): Promise<void> {
  const orderIds = (await prisma.order.findMany({ where: { merchantId: m.merchantId }, select: { id: true } })).map((o) => o.id);
  await prisma.broadcast.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.bill.deleteMany({ where: { merchantId: m.merchantId } });
  await prisma.order.deleteMany({ where: { merchantId: m.merchantId } });
  await prisma.template.deleteMany({ where: { merchantId: m.merchantId } });
  await prisma.merchant.deleteMany({ where: { id: m.merchantId } });
}

// The roadmap's literal verify SQL: SELECT status, count(*) ... WHERE merchantId.
async function rawCounts(merchantId: string): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<{ status: string; n: bigint }[]>`
    SELECT b."status" AS status, count(*) AS n
    FROM "Broadcast" b
    JOIN "Order" o ON b."orderId" = o."id"
    WHERE o."merchantId" = ${merchantId}
    GROUP BY b."status"
  `;
  const out: Record<string, number> = { PENDING: 0, SENT: 0, FAILED: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PortalDeliveriesService.getDeliveries (real DB)', () => {
  it('THE counts test — status counts reconcile EXACTLY to a hand-written GROUP BY over Broadcast JOIN Order', async () => {
    const m = await createScratchMerchant();
    try {
      const o1 = await createOrder(m);
      const o2 = await createOrder(m);
      await addBroadcast(o1, { status: 'SENT' });
      await addBroadcast(o1, { status: 'SENT' });
      await addBroadcast(o1, { status: 'PENDING' });
      await addBroadcast(o2, { status: 'FAILED', attempts: 2 });
      await addBroadcast(o2, { status: 'FAILED', attempts: 5 });

      const result = await service.getDeliveries(m.merchantId);
      const raw = await rawCounts(m.merchantId);

      expect(result.counts).toEqual(raw);
      expect(result.counts).toEqual({ PENDING: 1, SENT: 2, FAILED: 2 });
    } finally {
      await cleanup(m);
    }
  });

  it('zero-fills a status with no rows — reconciles to the raw SELECT which simply omits it', async () => {
    const m = await createScratchMerchant();
    try {
      const o = await createOrder(m);
      await addBroadcast(o, { status: 'SENT' });

      const result = await service.getDeliveries(m.merchantId);
      expect(result.counts).toEqual(await rawCounts(m.merchantId));
      expect(result.counts).toEqual({ PENDING: 0, SENT: 1, FAILED: 0 });
    } finally {
      await cleanup(m);
    }
  });

  it('THE cross-merchant test — merchant B\'s broadcasts absent from A\'s counts AND list, cross-checked against a direct SELECT', async () => {
    const a = await createScratchMerchant();
    const b = await createScratchMerchant();
    try {
      const oa = await createOrder(a, true);
      await addBroadcast(oa, { status: 'FAILED', attempts: 3, recipient: 'a-cust@example.com' });

      const ob = await createOrder(b, true);
      await addBroadcast(ob, { status: 'FAILED', attempts: 4, recipient: 'b-cust@example.com' });
      await addBroadcast(ob, { status: 'SENT' });

      const resultA = await service.getDeliveries(a.merchantId);

      // Counts: A's only, reconciled to A's raw SELECT.
      expect(resultA.counts).toEqual(await rawCounts(a.merchantId));
      expect(resultA.counts.FAILED).toBe(1);

      // Prove B genuinely has FAILED rows (so this isn't a false negative).
      const bFailedRaw = await prisma.broadcast.count({ where: { status: 'FAILED', order: { merchantId: b.merchantId } } });
      expect(bFailedRaw).toBeGreaterThan(0);

      // B's data appears nowhere in A's response.
      const serialized = JSON.stringify(resultA);
      expect(serialized).not.toContain('b-cust@example.com');
      expect(serialized).not.toContain('b-cust'); // even a mask fragment
      expect(resultA.failed.every((f) => f.billId !== null)).toBe(true);
      expect(resultA.failed).toHaveLength(1);

      // B independently reconciles to its own raw SELECT.
      const resultB = await service.getDeliveries(b.merchantId);
      expect(resultB.counts).toEqual(await rawCounts(b.merchantId));
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  it('a D-7-exhausted row (status FAILED, attempts == maxAttempts) is visible in the FAILED list for the first time', async () => {
    const m = await createScratchMerchant();
    try {
      const o = await createOrder(m, true);
      await addBroadcast(o, { status: 'FAILED', attempts: 5, channel: 'EMAIL', recipient: 'exhausted@example.com' });

      const result = await service.getDeliveries(m.merchantId);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].attempts).toBe(5);
      expect(result.failed[0].attempts >= result.maxAttempts).toBe(true); // "given up", derivable by the UI
      expect(result.failed[0].recipientMasked).toBe(maskEmailPortal('exhausted@example.com'));
      expect(result.failed[0].recipientMasked).not.toContain('exhausted');
    } finally {
      await cleanup(m);
    }
  });

  it('deny-test (integration): the raw recipient is nowhere in the serialized result', async () => {
    const m = await createScratchMerchant();
    const RAW = 'realcustomer9998887777@example.com';
    try {
      const o = await createOrder(m, true);
      await addBroadcast(o, { status: 'FAILED', attempts: 1, channel: 'EMAIL', recipient: RAW });

      const result = await service.getDeliveries(m.merchantId);
      expect(JSON.stringify(result)).not.toContain(RAW);
      expect(result.failed[0].recipientMasked).toBe(maskEmailPortal(RAW));
      expect(result.failed[0].recipientMasked).not.toContain('realcustomer');
      expect(result.failed[0].recipientMasked).not.toContain('9998887777');
    } finally {
      await cleanup(m);
    }
  });

  it('caps the FAILED list at 200 even when the merchant has more', async () => {
    const m = await createScratchMerchant();
    try {
      const o = await createOrder(m);
      await prisma.broadcast.createMany({
        data: Array.from({ length: 205 }, () => ({ orderId: o, channel: 'EMAIL' as const, recipient: 'x@example.com', status: 'FAILED' as const, attempts: 5 })),
      });

      const result = await service.getDeliveries(m.merchantId);
      expect(result.failed).toHaveLength(200);
      expect(result.counts.FAILED).toBe(205); // the COUNT is not capped
    } finally {
      await cleanup(m);
    }
  });
});

// ---- R-2 / D-69 / D-79: resend (real DB) --------------------------------
async function createBill(m: Scratch, orderId: string): Promise<string> {
  const billId = uid('bill');
  await prisma.bill.create({ data: { id: billId, orderId, merchantId: m.merchantId, billType: 'RECEIPT', templateId: m.templateId, totalPaise: 100n, snapshot: {} } });
  return billId;
}

async function addBroadcastRow(orderId: string, opts: { status: BroadcastStatus; channel?: 'EMAIL' | 'SMS'; recipient?: string; attempts?: number }) {
  return prisma.broadcast.create({
    data: {
      orderId,
      channel: opts.channel ?? 'EMAIL',
      recipient: opts.recipient ?? 'someone@example.com',
      status: opts.status,
      attempts: opts.attempts ?? 0,
      ...(opts.status === 'SENT' ? { sentAt: new Date() } : {}),
    },
  });
}

describe('PortalDeliveriesService.resend (real DB)', () => {
  it('THE one-new-row + old-row-byte-identical test — resend on a FAILED broadcast', async () => {
    const m = await createScratchMerchant();
    try {
      const orderId = await createOrder(m);
      const billId = await createBill(m, orderId);
      const failed = await addBroadcastRow(orderId, { status: 'FAILED', channel: 'EMAIL', recipient: 'cust-r2@example.com', attempts: 5 });

      const before = await prisma.broadcast.findUniqueOrThrow({ where: { id: failed.id } });
      const countBefore = await prisma.broadcast.count({ where: { orderId } });

      const result = await service.resend(m.merchantId, billId);
      expect(result).toEqual({ resent: true, channel: 'EMAIL' });

      // exactly one new row
      expect(await prisma.broadcast.count({ where: { orderId } })).toBe(countBefore + 1);

      // the OLD row is byte-identical — every column, including attempts / error / updatedAt
      const after = await prisma.broadcast.findUniqueOrThrow({ where: { id: failed.id } });
      expect(after).toEqual(before);

      // the NEW row: PENDING, attempts 0, channel + STORED recipient copied
      const fresh = await prisma.broadcast.findFirstOrThrow({ where: { orderId, id: { not: failed.id } } });
      expect(fresh.status).toBe('PENDING');
      expect(fresh.attempts).toBe(0);
      expect(fresh.channel).toBe('EMAIL');
      expect(fresh.recipient).toBe('cust-r2@example.com'); // the stored value
      expect(fresh.sentAt).toBeNull();
      expect(fresh.error).toBeNull();

      // it matches the drainer's candidate query (status PENDING branch)
      const pickable = await prisma.broadcast.findMany({
        where: { OR: [{ status: 'PENDING' }, { status: 'FAILED', attempts: { lt: 5 } }] },
      });
      expect(pickable.some((b) => b.id === fresh.id)).toBe(true);
    } finally {
      await cleanup(m);
    }
  });

  it('refused while a PENDING exists for the SAME order (any channel) — 422 RESEND_ALREADY_PENDING, zero writes', async () => {
    const m = await createScratchMerchant();
    try {
      const orderId = await createOrder(m);
      const billId = await createBill(m, orderId);
      await addBroadcastRow(orderId, { status: 'FAILED', channel: 'EMAIL', recipient: 'e@example.com' });
      await addBroadcastRow(orderId, { status: 'PENDING', channel: 'SMS', recipient: '9990001111' }); // different channel

      const countBefore = await prisma.broadcast.count({ where: { orderId } });
      const err = await service.resend(m.merchantId, billId).catch((e) => e);
      expect((err as { getResponse: () => unknown }).getResponse()).toMatchObject({ error_code: 'RESEND_ALREADY_PENDING' });
      expect(await prisma.broadcast.count({ where: { orderId } })).toBe(countBefore);
    } finally {
      await cleanup(m);
    }
  });

  it('a PENDING on a DIFFERENT order does NOT block the resend', async () => {
    const m = await createScratchMerchant();
    try {
      const orderA = await createOrder(m);
      const billA = await createBill(m, orderA);
      await addBroadcastRow(orderA, { status: 'FAILED', recipient: 'a@example.com' });

      const orderB = await createOrder(m);
      await addBroadcastRow(orderB, { status: 'PENDING', recipient: 'b@example.com' });

      const result = await service.resend(m.merchantId, billA);
      expect(result.resent).toBe(true);
    } finally {
      await cleanup(m);
    }
  });

  it('the partial unique index rejects a second PENDING for one order at the DB level', async () => {
    const m = await createScratchMerchant();
    try {
      const orderId = await createOrder(m);
      await addBroadcastRow(orderId, { status: 'PENDING', recipient: 'one@example.com' });
      await expect(addBroadcastRow(orderId, { status: 'PENDING', recipient: 'two@example.com' })).rejects.toMatchObject({ code: 'P2002' });
      // SENT/FAILED are unconstrained
      await expect(addBroadcastRow(orderId, { status: 'SENT', recipient: 'three@example.com' })).resolves.toBeTruthy();
      await expect(addBroadcastRow(orderId, { status: 'FAILED', recipient: 'four@example.com' })).resolves.toBeTruthy();
    } finally {
      await cleanup(m);
    }
  });

  it('422 NO_FAILED_BROADCAST when the bill has only SENT broadcasts — zero writes', async () => {
    const m = await createScratchMerchant();
    try {
      const orderId = await createOrder(m);
      const billId = await createBill(m, orderId);
      await addBroadcastRow(orderId, { status: 'SENT', recipient: 's@example.com' });

      const countBefore = await prisma.broadcast.count({ where: { orderId } });
      const err = await service.resend(m.merchantId, billId).catch((e) => e);
      expect((err as { getResponse: () => unknown }).getResponse()).toMatchObject({ error_code: 'NO_FAILED_BROADCAST' });
      expect(await prisma.broadcast.count({ where: { orderId } })).toBe(countBefore);
    } finally {
      await cleanup(m);
    }
  });

  it('cross-merchant billId → 404 (NotFoundException), zero writes', async () => {
    const a = await createScratchMerchant();
    const b = await createScratchMerchant();
    try {
      const orderB = await createOrder(b);
      const billB = await createBill(b, orderB);
      await addBroadcastRow(orderB, { status: 'FAILED', recipient: 'b-cust@example.com' });

      const countBefore = await prisma.broadcast.count({ where: { orderId: orderB } });
      await expect(service.resend(a.merchantId, billB)).rejects.toThrow(/Not Found|NotFound/i);
      expect(await prisma.broadcast.count({ where: { orderId: orderB } })).toBe(countBefore);
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  it('resends regardless of attempts count (D-79 NIT-2) — a FAILED row at attempts 1 still resends', async () => {
    const m = await createScratchMerchant();
    try {
      const orderId = await createOrder(m);
      const billId = await createBill(m, orderId);
      await addBroadcastRow(orderId, { status: 'FAILED', attempts: 1, recipient: 'notexhausted@example.com' });

      const result = await service.resend(m.merchantId, billId);
      expect(result.resent).toBe(true);
      expect(await prisma.broadcast.count({ where: { orderId, status: 'PENDING' } })).toBe(1);
    } finally {
      await cleanup(m);
    }
  });
});
