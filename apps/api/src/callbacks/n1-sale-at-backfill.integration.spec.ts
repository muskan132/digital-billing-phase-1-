// N-1 / D-83: real-Postgres coverage for the sale-at backfill. The two proofs
// that matter most, per the roadmap's own verify-locally line and the D-83
// addendum this task added:
//   1. The backfill is idempotent — run twice, identical result — and
//      recomputes purely from paymentDateTime (byte-identical afterwards),
//      not from any previously-computed saleAt.
//   2. Changing the offset and re-running produces a uniformly shifted
//      result — only possible because the backfill recomputes EVERY row
//      unconditionally, never gated on saleAt IS NULL (unlike Q-4's).
import { PrismaClient } from '@prisma/client';
import { backfillSaleAt } from '../../scripts/backfill-sale-at';
import { IST_ZONE } from '../common/sale-time.util';

const prisma = new PrismaClient();
let counter = 0;
const uid = (p: string) => `n1-itest-${p}-${Date.now()}-${++counter}`;

interface Scratch {
  merchantId: string;
}

async function createScratchMerchant(): Promise<Scratch> {
  const merchantId = uid('merchant');
  await prisma.merchant.create({
    data: { id: merchantId, jiopayMid: uid('mid'), name: `N-1 itest ${merchantId}`, secretKeyEnc: Buffer.from('unused') },
  });
  return { merchantId };
}

async function createScratchOrder(m: Scratch, paymentDateTime: string | null, saleAt: Date | null = null): Promise<string> {
  const orderId = uid('order');
  await prisma.order.create({
    data: {
      id: orderId,
      merchantId: m.merchantId,
      status: 'SUCCESS',
      externalTransactionId: uid('ext'),
      rawCallback: {},
      paymentDateTime,
      saleAt,
    },
  });
  return orderId;
}

async function cleanup(m: Scratch): Promise<void> {
  await prisma.order.deleteMany({ where: { merchantId: m.merchantId } });
  await prisma.merchant.delete({ where: { id: m.merchantId } });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('backfillSaleAt (real DB) — N-1 / D-83', () => {
  it('recomputes saleAt from paymentDateTime for valid, malformed, and absent values', async () => {
    const m = await createScratchMerchant();
    try {
      const validOrder = await createScratchOrder(m, '20260916140000');
      const malformedOrder = await createScratchOrder(m, 'not-a-date');
      const absentOrder = await createScratchOrder(m, null);

      const result = await backfillSaleAt(prisma, IST_ZONE, m.merchantId);
      expect(result.processed).toBe(2); // absentOrder has no paymentDateTime — excluded from the target set
      expect(result.unparseable).toBe(1);

      const valid = await prisma.order.findUnique({ where: { id: validOrder } });
      const malformed = await prisma.order.findUnique({ where: { id: malformedOrder } });
      const absent = await prisma.order.findUnique({ where: { id: absentOrder } });

      expect(valid?.saleAt).toEqual(new Date('2026-09-16T08:30:00.000Z'));
      expect(malformed?.saleAt).toBeNull();
      expect(absent?.saleAt).toBeNull(); // untouched — no paymentDateTime to derive from
      expect(valid?.paymentDateTime).toBe('20260916140000'); // raw string never modified
    } finally {
      await cleanup(m);
    }
  });

  it('THE idempotency test: running twice produces an identical result, and paymentDateTime is byte-identical afterwards', async () => {
    const m = await createScratchMerchant();
    try {
      const orderId = await createScratchOrder(m, '20260916140000');

      const firstRun = await backfillSaleAt(prisma, IST_ZONE, m.merchantId);
      const afterFirst = await prisma.order.findUnique({ where: { id: orderId } });

      const secondRun = await backfillSaleAt(prisma, IST_ZONE, m.merchantId);
      const afterSecond = await prisma.order.findUnique({ where: { id: orderId } });

      expect(secondRun.processed).toBe(firstRun.processed);
      expect(secondRun.unparseable).toBe(firstRun.unparseable);
      // Second run changes nothing — every row already matches what a fresh
      // recompute from paymentDateTime produces.
      expect(secondRun.changed).toBe(0);
      expect(afterSecond?.saleAt).toEqual(afterFirst?.saleAt);
      expect(afterSecond?.paymentDateTime).toBe(afterFirst?.paymentDateTime);
      expect(afterSecond?.paymentDateTime).toBe('20260916140000');
    } finally {
      await cleanup(m);
    }
  });

  it('unconditionally recomputes even an already-non-null saleAt — never gated on saleAt IS NULL', async () => {
    const m = await createScratchMerchant();
    try {
      // Seed with a deliberately WRONG saleAt, standing in for a row backfilled
      // under a stale/incorrect offset. A skip-if-populated backfill (Q-4's
      // pattern) would leave this untouched; N-1's must correct it.
      const orderId = await createScratchOrder(m, '20260916140000', new Date('1999-01-01T00:00:00.000Z'));

      const result = await backfillSaleAt(prisma, IST_ZONE, m.merchantId);
      expect(result.changed).toBe(1);

      const after = await prisma.order.findUnique({ where: { id: orderId } });
      expect(after?.saleAt).toEqual(new Date('2026-09-16T08:30:00.000Z'));
    } finally {
      await cleanup(m);
    }
  });

  // THE test the roadmap names explicitly: "changing IST_ZONE and re-running
  // produces a uniformly shifted result — proving the interpretation lives in
  // one place." Only possible because the backfill recomputes every row on
  // every run, not just newly-null ones.
  it('changing the offset and re-running produces a uniformly shifted result across every row', async () => {
    const m = await createScratchMerchant();
    try {
      const orderA = await createScratchOrder(m, '20260916140000');
      const orderB = await createScratchOrder(m, '20260101093000');

      await backfillSaleAt(prisma, IST_ZONE, m.merchantId);
      const beforeA = (await prisma.order.findUnique({ where: { id: orderA } }))!.saleAt!;
      const beforeB = (await prisma.order.findUnique({ where: { id: orderB } }))!.saleAt!;

      const shiftedOffset = IST_ZONE - 60; // simulate a one-hour correction to the constant
      const secondRun = await backfillSaleAt(prisma, shiftedOffset, m.merchantId);
      expect(secondRun.changed).toBe(2); // both rows shift — neither was skipped

      const afterA = (await prisma.order.findUnique({ where: { id: orderA } }))!.saleAt!;
      const afterB = (await prisma.order.findUnique({ where: { id: orderB } }))!.saleAt!;

      const expectedShiftMs = 60 * 60_000;
      expect(afterA.getTime() - beforeA.getTime()).toBe(expectedShiftMs);
      expect(afterB.getTime() - beforeB.getTime()).toBe(expectedShiftMs);
    } finally {
      await cleanup(m);
    }
  });
});
