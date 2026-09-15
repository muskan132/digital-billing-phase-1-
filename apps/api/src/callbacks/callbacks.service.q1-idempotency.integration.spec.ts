// Q-1 (D-8/D-9): real-Postgres coverage for the callback idempotency race.
//
// Two proofs, both required — neither alone is sufficient for a Tier-1
// money-path guarantee:
//   1. A deterministic, mocked-service-layer test: force order.upsert to
//      throw a P2002 shaped exactly like the real one (confirmed by
//      triggering a genuine Order.txnId collision against this same DB
//      before writing this test — see the shape asserted below), and prove
//      the catch in callbacks.service.ts resolves normally rather than
//      rethrowing. This proves the catch logic in isolation, independent of
//      whether a real race is ever hit in a given run.
//   2. A repeated real-concurrency burst (10 runs x 30 parallel identical
//      callbacks) against real Postgres: real-world evidence the actual
//      race window closes under load, not a simulated/sequential stand-in.
//
// Plus the roadmap's other named requirement: a P2002 from an unrelated
// constraint (Link.identifier) must still propagate, not be swallowed.
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CallbacksService } from './callbacks.service';
import { JioPayCallbackDto } from './jiopay-callback.dto';
import * as linkIdUtil from '../common/link-id.util';

const prisma = new PrismaClient();

let counter = 0;
const uid = (p: string) => `q1-itest-${p}-${Date.now()}-${++counter}`;

interface Scratch {
  merchantId: string;
  jiopayMid: string;
  templateId: string;
}

async function createScratchMerchant(): Promise<Scratch> {
  const jiopayMid = uid('mid');
  const merchant = await prisma.merchant.create({
    data: { jiopayMid, name: `Q-1 itest ${jiopayMid}`, secretKeyEnc: Buffer.from('unused') },
  });
  const template = await prisma.template.create({
    data: {
      id: uid('template'),
      merchantId: merchant.id,
      name: `Q-1 itest template ${merchant.id}`,
      billType: 'RECEIPT',
      layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] },
      isHead: true,
    },
  });
  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { defaultReceiptTemplateId: template.id, defaultChannel: 'EMAIL' },
  });
  return { merchantId: merchant.id, jiopayMid, templateId: template.id };
}

async function cleanup(m: Scratch): Promise<void> {
  const orderIds = (await prisma.order.findMany({ where: { merchantId: m.merchantId }, select: { id: true } })).map((o) => o.id);
  await prisma.broadcast.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.link.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.bill.deleteMany({ where: { merchantId: m.merchantId } });
  await prisma.order.deleteMany({ where: { merchantId: m.merchantId } });
  await prisma.merchant.update({ where: { id: m.merchantId }, data: { defaultReceiptTemplateId: null } });
  await prisma.template.deleteMany({ where: { merchantId: m.merchantId } });
  await prisma.merchant.delete({ where: { id: m.merchantId } });
}

function makeCallback(m: Scratch, txnId: string, overrides: Partial<JioPayCallbackDto> = {}): JioPayCallbackDto {
  return {
    txnID: txnId,
    merchantId: m.jiopayMid,
    responseCode: '0000',
    amount: '1.00',
    merchantTxnNo: `mtxn-${txnId}`,
    paymentID: `pay-${txnId}`,
    paymentMode: 'UPI',
    paymentDateTime: '20260915120000',
    customerEmailID: 'customer@example.com',
    ...overrides,
  };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('CallbacksService.persist — Q-1 idempotency race (real DB)', () => {
  // Proof 1: deterministic, isolated proof the catch logic is correct —
  // independent of whether a real race actually interleaves in this run.
  describe('mocked-service-layer: catch logic in isolation', () => {
    it('resolves normally when order.upsert throws the REAL shape of a txnId P2002 (confirmed live against this DB before writing this test: code="P2002", meta={ modelName: "Order", target: ["txnId"] })', async () => {
      const realShapeError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`txnId`)', {
        code: 'P2002',
        clientVersion: '6.19.3',
        meta: { modelName: 'Order', target: ['txnId'] },
      });
      const upsert = jest.fn().mockRejectedValue(realShapeError);
      const prismaMock = {
        merchant: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'merchant_1',
            name: 'Test Merchant',
            defaultChannel: 'EMAIL',
            defaultReceiptTemplate: {
              id: 'template_1',
              billType: 'RECEIPT',
              skeleton: 'MINIMALIST',
              layoutSchema: [],
              version: 1,
            },
          }),
        },
        order: { upsert },
      } as unknown as PrismaService;

      const service = new CallbacksService(prismaMock);
      await expect(service.persist(makeCallback({ merchantId: '', jiopayMid: 'JP1', templateId: '' }, 'txn_mock_1'), {})).resolves.toBeUndefined();
      expect(upsert).toHaveBeenCalledTimes(1);
    });

    it('RETHROWS a P2002 from an unrelated constraint (Link.identifier) — proves the catch does not silently swallow an unrelated conflict', async () => {
      const unrelatedShapeError = new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`identifier`)', {
        code: 'P2002',
        clientVersion: '6.19.3',
        meta: { modelName: 'Link', target: ['identifier'] },
      });
      const upsert = jest.fn().mockRejectedValue(unrelatedShapeError);
      const prismaMock = {
        merchant: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'merchant_1',
            name: 'Test Merchant',
            defaultChannel: 'EMAIL',
            defaultReceiptTemplate: {
              id: 'template_1',
              billType: 'RECEIPT',
              skeleton: 'MINIMALIST',
              layoutSchema: [],
              version: 1,
            },
          }),
        },
        order: { upsert },
      } as unknown as PrismaService;

      const service = new CallbacksService(prismaMock);
      await expect(
        service.persist(makeCallback({ merchantId: '', jiopayMid: 'JP1', templateId: '' }, 'txn_mock_2'), {}),
      ).rejects.toThrow(unrelatedShapeError);
    });
  });

  // Proof 2: real-world evidence against a real DB, under real concurrency,
  // repeated 10 times to convert "statistical near-certainty" into a
  // materially stronger repeated guarantee.
  describe('repeated real-concurrency burst (real DB, real race — not simulated)', () => {
    const RUNS = 10;
    const PARALLELISM = 30;

    it(`10 runs of a 30-way parallel burst each produce exactly one Order/Bill/Link and at most one Broadcast, zero 500s`, async () => {
      const results: { run: number; resolved: number; rejected: number; orders: number; bills: number; links: number; broadcasts: number }[] = [];

      for (let run = 1; run <= RUNS; run++) {
        const m = await createScratchMerchant();
        const service = new CallbacksService(prisma as unknown as PrismaService);
        const txnId = uid(`race-run${run}`);
        try {
          const outcomes = await Promise.allSettled(
            Array.from({ length: PARALLELISM }, () => service.persist(makeCallback(m, txnId), {})),
          );
          const resolved = outcomes.filter((o) => o.status === 'fulfilled').length;
          const rejected = outcomes.filter((o) => o.status === 'rejected').length;

          const orders = await prisma.order.count({ where: { txnId } });
          const order = await prisma.order.findUniqueOrThrow({ where: { txnId } });
          const bills = await prisma.bill.count({ where: { orderId: order.id } });
          const links = await prisma.link.count({ where: { orderId: order.id } });
          const broadcasts = await prisma.broadcast.count({ where: { orderId: order.id } });

          results.push({ run, resolved, rejected, orders, bills, links, broadcasts });
        } finally {
          await cleanup(m);
        }
      }

      // eslint-disable-next-line no-console
      console.log('Q-1 burst results (10 runs x 30-way parallel):', JSON.stringify(results, null, 2));

      for (const r of results) {
        expect(r.rejected).toBe(0); // no 500s — every concurrent call resolved
        expect(r.resolved).toBe(PARALLELISM);
        expect(r.orders).toBe(1);
        expect(r.bills).toBe(1);
        expect(r.links).toBe(1);
        expect(r.broadcasts).toBeLessThanOrEqual(1);
      }
    }, 120_000);
  });

  // Named separately per the roadmap's own verify line and the review
  // ruling: this is one of the two results that matter most.
  describe('forced OTHER P2002 (real DB): a genuinely unrelated conflict still propagates', () => {
    it('a Link.identifier collision forced via a mocked generateIdentifier() is NOT swallowed — it rejects, does not resolve as a no-op', async () => {
      const m = await createScratchMerchant();
      const fixedIdentifier = uid('fixed-identifier');
      const spy = jest.spyOn(linkIdUtil, 'generateIdentifier').mockReturnValue(fixedIdentifier);
      try {
        const service = new CallbacksService(prisma as unknown as PrismaService);
        const txnA = uid('conflict-a');
        const txnB = uid('conflict-b');

        // First callback succeeds and claims the fixed identifier for real.
        await service.persist(makeCallback(m, txnA), {});
        const orderA = await prisma.order.findUniqueOrThrow({ where: { txnId: txnA } });
        const linkA = await prisma.link.findUnique({ where: { orderId: orderA.id } });
        expect(linkA?.identifier).toBe(fixedIdentifier);

        // Second callback, a DIFFERENT txnId, collides on Link.identifier —
        // this is not the txnId race Q-1 patches, and must still surface as
        // an error, proving the catch does not broadly swallow all P2002s.
        await expect(service.persist(makeCallback(m, txnB), {})).rejects.toMatchObject({ code: 'P2002' });

        // No Order/Bill/Link/Broadcast exists for txnB — the failed nested
        // write rolled back as a unit.
        const orderB = await prisma.order.findUnique({ where: { txnId: txnB } });
        expect(orderB).toBeNull();
      } finally {
        spy.mockRestore();
        await cleanup(m);
      }
    });
  });
});
