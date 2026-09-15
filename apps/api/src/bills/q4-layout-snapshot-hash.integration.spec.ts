// Q-4 / D-95: real-Postgres coverage for the retired-baseline-file blind spot
// and its replacement, the self-certifying Bill.layoutSnapshotHash column.
//
// The two proofs that matter most:
//   1. Mutating the layoutSnapshot of a bill created AFTER any baseline
//      commit could ever have existed — i.e. a bill this repo's real
//      committed baseline file never had a key for — now fails the check.
//      This is the literal blind spot named in the roadmap.
//   2. A regression check: an "existing baseline case" (a bill whose hash
//      was populated by the backfill, standing in for the ~60 bills that
//      really were backfilled from the old baseline) still fails exactly
//      as before when mutated — no coverage was lost in the transition.
// Plus: a clean, unmutated bill passes; a bill missing its hash entirely
// (pre-backfill state) is flagged, not silently skipped.
import { Prisma, PrismaClient } from '@prisma/client';
import { checkLayoutSnapshotImmutability } from '../../scripts/verify-v3-task';
import { hashSnapshot } from '../common/layout-snapshot-hash.util';

const prisma = new PrismaClient();
let counter = 0;
const uid = (p: string) => `q4-itest-${p}-${Date.now()}-${++counter}`;

interface Scratch {
  merchantId: string;
  templateId: string;
}

async function createScratchMerchant(): Promise<Scratch> {
  const merchantId = uid('merchant');
  await prisma.merchant.create({
    data: { id: merchantId, jiopayMid: uid('mid'), name: `Q-4 itest ${merchantId}`, secretKeyEnc: Buffer.from('unused') },
  });
  const templateId = uid('template');
  await prisma.template.create({
    data: { id: templateId, merchantId, name: `Q-4 itest template ${templateId}`, billType: 'RECEIPT', layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] }, isHead: true },
  });
  return { merchantId, templateId };
}

async function createScratchBill(m: Scratch, layoutSnapshot: object | null, layoutSnapshotHash: string | null): Promise<string> {
  const orderId = uid('order');
  await prisma.order.create({
    data: { id: orderId, merchantId: m.merchantId, status: 'SUCCESS', externalTransactionId: uid('ext'), rawCallback: {} },
  });
  const billId = uid('bill');
  await prisma.bill.create({
    data: {
      id: billId,
      orderId,
      merchantId: m.merchantId,
      billType: 'RECEIPT',
      templateId: m.templateId,
      totalPaise: 100n,
      snapshot: {},
      layoutSnapshot: layoutSnapshot ?? Prisma.DbNull,
      layoutSnapshotHash,
    },
  });
  return billId;
}

async function cleanup(m: Scratch): Promise<void> {
  const orderIds = (await prisma.order.findMany({ where: { merchantId: m.merchantId }, select: { id: true } })).map((o) => o.id);
  await prisma.bill.deleteMany({ where: { merchantId: m.merchantId } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.template.deleteMany({ where: { merchantId: m.merchantId } });
  await prisma.merchant.delete({ where: { id: m.merchantId } });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('checkLayoutSnapshotImmutability (real DB) — Q-4 blind-spot closure', () => {
  it('THE test: mutating the layoutSnapshot of a bill created after any baseline commit — never a key in the retired file — now fails the check', async () => {
    const m = await createScratchMerchant();
    try {
      const snapshot = { schemaVersion: 1, skeleton: 'MINIMALIST', blocks: [{ type: 'HEADER' }], templateId: m.templateId, templateVersion: 1 };
      // Written exactly as the real write paths do: hash computed at creation
      // from the same snapshot, via the same shared util.
      const billId = await createScratchBill(m, snapshot, hashSnapshot(snapshot));

      const before = await checkLayoutSnapshotImmutability(prisma);
      expect(before.detail ?? '').not.toContain(billId);

      // Bypass the application layer entirely — a direct DB write, same
      // shape a real corruption (or an attacker with DB access) would take.
      // layoutSnapshotHash is deliberately left untouched, exactly as a real
      // corruption would: the attacker doesn't know to also forge the hash.
      await prisma.bill.update({ where: { id: billId }, data: { layoutSnapshot: { ...snapshot, blocks: [{ type: 'FOOTER', tampered: true }] } } });

      const after = await checkLayoutSnapshotImmutability(prisma);
      expect(after.ok).toBe(false);
      expect(after.detail ?? '').toContain(billId);
      expect(after.detail ?? '').toContain('immutability violated');
    } finally {
      await cleanup(m);
    }
  });

  it('REGRESSION: an existing-baseline-style bill (hash populated by backfill, standing in for the real ~60 backfilled bills) still fails when mutated', async () => {
    const m = await createScratchMerchant();
    try {
      const snapshot = { schemaVersion: 1, skeleton: 'COMPACT_THERMAL', blocks: [{ type: 'ITEMS' }], templateId: m.templateId, templateVersion: 1 };
      // Simulates the backfill script's own logic: hash derived AFTER the
      // fact from the bill's current (trusted-as-of-backfill) snapshot,
      // rather than written at creation time.
      const billId = await createScratchBill(m, snapshot, null);
      await prisma.bill.update({ where: { id: billId }, data: { layoutSnapshotHash: hashSnapshot(snapshot) } });

      const before = await checkLayoutSnapshotImmutability(prisma);
      expect(before.detail ?? '').not.toContain(billId);

      await prisma.bill.update({ where: { id: billId }, data: { layoutSnapshot: { ...snapshot, blocks: [] } } });

      const after = await checkLayoutSnapshotImmutability(prisma);
      expect(after.ok).toBe(false);
      expect(after.detail ?? '').toContain(billId);
    } finally {
      await cleanup(m);
    }
  });

  it('a clean, unmutated bill passes (does not appear in mismatches)', async () => {
    const m = await createScratchMerchant();
    try {
      const snapshot = { schemaVersion: 1, skeleton: 'RETAIL', blocks: [], templateId: m.templateId, templateVersion: 1 };
      const billId = await createScratchBill(m, snapshot, hashSnapshot(snapshot));

      const result = await checkLayoutSnapshotImmutability(prisma);
      expect(result.detail ?? '').not.toContain(billId);
    } finally {
      await cleanup(m);
    }
  });

  it('a bill with a layoutSnapshot but no layoutSnapshotHash (pre-backfill state) is flagged, not silently skipped', async () => {
    const m = await createScratchMerchant();
    try {
      const snapshot = { schemaVersion: 1, skeleton: 'RESTAURANT', blocks: [], templateId: m.templateId, templateVersion: 1 };
      const billId = await createScratchBill(m, snapshot, null);

      const result = await checkLayoutSnapshotImmutability(prisma);
      expect(result.ok).toBe(false);
      expect(result.detail ?? '').toContain(billId);
      expect(result.detail ?? '').toContain('backfill-layout-snapshot-hash');
    } finally {
      await cleanup(m);
    }
  });

  it('a bill with no layoutSnapshot at all is skipped entirely — nothing to protect', async () => {
    const m = await createScratchMerchant();
    try {
      const billId = await createScratchBill(m, null, null);

      const result = await checkLayoutSnapshotImmutability(prisma);
      expect(result.detail ?? '').not.toContain(billId);
    } finally {
      await cleanup(m);
    }
  });
});
