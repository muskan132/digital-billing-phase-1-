// H-1: real-Postgres integration coverage for the two guarantees a mocked
// PrismaService cannot prove — cross-merchant isolation (independently
// cross-checked against a raw count, not just "the mock returned what we
// told it to") and keyset pagination staying correct across a real insert
// between two sequential page fetches. Every other *.service.spec.ts in
// this repo mocks PrismaService entirely; that's kept for portal-bills.
// service.spec.ts's scoping/DTO/validation tests, but those two specific
// guarantees are not meaningfully testable against a mock, so this file
// exists alongside it and talks to the real dev Postgres (same DB the
// verify-a2/verify-w1 scripts already use over ts-node).
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PortalBillsService } from './portal-bills.service';

const prisma = new PrismaClient();
const service = new PortalBillsService(prisma as unknown as PrismaService);

let counter = 0;
function uniqueId(prefix: string): string {
  counter += 1;
  return `h1-itest-${prefix}-${Date.now()}-${counter}`;
}

interface ScratchMerchant {
  merchantId: string;
  templateId: string;
}

async function createScratchMerchant(): Promise<ScratchMerchant> {
  const merchantId = uniqueId('merchant');
  await prisma.merchant.create({
    data: {
      id: merchantId,
      jiopayMid: uniqueId('mid'),
      name: `H-1 itest ${merchantId}`,
      secretKeyEnc: Buffer.from('unused'),
    },
  });
  const templateId = uniqueId('template');
  await prisma.template.create({
    data: {
      id: templateId,
      merchantId,
      name: `H-1 itest template ${templateId}`,
      billType: 'RECEIPT',
      layoutSchema: [{ type: 'HEADER', order: 1, props: {} }],
    },
  });
  return { merchantId, templateId };
}

async function createBill(
  merchant: ScratchMerchant,
  opts: {
    createdAt: Date;
    source?: 'PG_CALLBACK' | 'DIRECT_API';
    billType?: 'RECEIPT' | 'TAX_INVOICE';
    customerMobile?: string;
    customerEmail?: string;
  },
): Promise<string> {
  const orderId = uniqueId('order');
  await prisma.order.create({
    data: {
      id: orderId,
      merchantId: merchant.merchantId,
      externalTransactionId: uniqueId('ext'),
      source: opts.source ?? 'PG_CALLBACK',
      status: 'SUCCESS',
      amountPaise: 10000n,
      customerMobile_pii: opts.customerMobile,
      customerEmail_pii: opts.customerEmail,
      rawCallback: {},
    },
  });
  const billId = uniqueId('bill');
  await prisma.bill.create({
    data: {
      id: billId,
      orderId,
      merchantId: merchant.merchantId,
      billType: opts.billType ?? 'RECEIPT',
      templateId: merchant.templateId,
      totalPaise: 10000n,
      snapshot: {},
      createdAt: opts.createdAt,
    },
  });
  return billId;
}

async function cleanupMerchant(merchant: ScratchMerchant): Promise<void> {
  await prisma.bill.deleteMany({ where: { merchantId: merchant.merchantId } });
  await prisma.order.deleteMany({ where: { merchantId: merchant.merchantId } });
  await prisma.template.deleteMany({ where: { merchantId: merchant.merchantId } });
  await prisma.merchant.deleteMany({ where: { id: merchant.merchantId } });
}

const T0 = new Date('2026-08-01T00:00:00.000Z');
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PortalBillsService.list — cross-merchant isolation (real DB)', () => {
  let merchantA: ScratchMerchant;
  let merchantB: ScratchMerchant;

  beforeAll(async () => {
    merchantA = await createScratchMerchant();
    merchantB = await createScratchMerchant();
    await createBill(merchantA, { createdAt: minutes(0) });
    await createBill(merchantA, { createdAt: minutes(1) });
    await createBill(merchantB, { createdAt: minutes(0) });
    await createBill(merchantB, { createdAt: minutes(1) });
    await createBill(merchantB, { createdAt: minutes(2) });
  });

  afterAll(async () => {
    await cleanupMerchant(merchantA);
    await cleanupMerchant(merchantB);
  });

  it("returns exactly merchant A's bills, matching an independent raw count, never merchant B's", async () => {
    const [resultA, rawCountA, rawCountB] = await Promise.all([
      service.list(merchantA.merchantId, { filters: {} }),
      prisma.bill.count({ where: { merchantId: merchantA.merchantId } }),
      prisma.bill.count({ where: { merchantId: merchantB.merchantId } }),
    ]);

    expect(rawCountA).toBe(2);
    expect(rawCountB).toBe(3);
    expect(resultA.items).toHaveLength(rawCountA);
    expect(resultA.items.every((item) => !item.id.includes('should-not-happen'))).toBe(true);

    const resultB = await service.list(merchantB.merchantId, { filters: {} });
    expect(resultB.items).toHaveLength(rawCountB);

    const idsA = new Set(resultA.items.map((i) => i.id));
    const idsB = new Set(resultB.items.map((i) => i.id));
    for (const id of idsA) expect(idsB.has(id)).toBe(false);
    for (const id of idsB) expect(idsA.has(id)).toBe(false);
  });
});

describe('PortalBillsService.list — source filter partitions exactly (real DB)', () => {
  let merchant: ScratchMerchant;
  let pgBillId: string;
  let directBillId: string;

  beforeAll(async () => {
    merchant = await createScratchMerchant();
    pgBillId = await createBill(merchant, { createdAt: minutes(0), source: 'PG_CALLBACK' });
    directBillId = await createBill(merchant, { createdAt: minutes(1), source: 'DIRECT_API' });
  });

  afterAll(async () => {
    await cleanupMerchant(merchant);
  });

  it('source=DIRECT_API excludes the PG_CALLBACK row and vice versa', async () => {
    const direct = await service.list(merchant.merchantId, { filters: { source: 'DIRECT_API' } });
    expect(direct.items.map((i) => i.id)).toEqual([directBillId]);

    const pg = await service.list(merchant.merchantId, { filters: { source: 'PG_CALLBACK' } });
    expect(pg.items.map((i) => i.id)).toEqual([pgBillId]);
  });
});

describe('PortalBillsService.list — keyset pagination survives a real insert between two fetches (real DB)', () => {
  let merchant: ScratchMerchant;
  let b1: string, b2: string, b3: string;

  beforeAll(async () => {
    merchant = await createScratchMerchant();
    b1 = await createBill(merchant, { createdAt: minutes(0) }); // oldest
    b2 = await createBill(merchant, { createdAt: minutes(10) });
    b3 = await createBill(merchant, { createdAt: minutes(20) }); // newest
  });

  afterAll(async () => {
    await cleanupMerchant(merchant);
  });

  it('a row inserted into the already-paginated-past region is skipped/repeated exactly nowhere', async () => {
    // Page 1, before any insert: newest-first, limit 2 -> [b3, b2].
    const page1 = await service.list(merchant.merchantId, { filters: {}, limit: 2 });
    expect(page1.items.map((i) => i.id)).toEqual([b3, b2]);
    expect(page1.nextCursor).not.toBeNull();

    // Insert AFTER page1 was fetched: b4 lands strictly between b1 and b2 —
    // i.e. inside the region page1's cursor has not reached yet.
    const b4 = await createBill(merchant, { createdAt: minutes(5) });
    // Insert b5 newer than everything — i.e. it would have belonged on
    // page1 had it existed earlier. Page2 must NOT be affected by it either
    // way: it's newer than the cursor boundary, out of page2's range.
    const b5 = await createBill(merchant, { createdAt: minutes(25) });

    // Page 2, using the cursor captured BEFORE b4/b5 existed.
    const page2 = await service.list(merchant.merchantId, { filters: {}, cursor: page1.nextCursor! });

    // Exactly b4 then b1 (newest-first among what's left) — b4 correctly
    // appears (the query re-runs live against current state, keyed off the
    // cursor's own createdAt/id, not a frozen offset/count), and b5 does
    // NOT appear (it's newer than the cursor boundary — no duplication,
    // no skip of what page1 already returned).
    expect(page2.items.map((i) => i.id)).toEqual([b4, b1]);
    expect(page2.items.some((i) => i.id === b5)).toBe(false);
    expect(page2.items.some((i) => i.id === b2 || i.id === b3)).toBe(false); // no repeat of page1
    expect(page2.nextCursor).toBeNull();

    // A fresh, cursor-less request now correctly reflects b5 as newest —
    // this is expected freshness, not the bug the above proves absent.
    const freshFirstPage = await service.list(merchant.merchantId, { filters: {}, limit: 2 });
    expect(freshFirstPage.items.map((i) => i.id)).toEqual([b5, b3]);
  });
});
