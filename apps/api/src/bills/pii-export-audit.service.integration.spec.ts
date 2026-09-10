// E-1 / D-70 / D-80: real-Postgres coverage — the FK integrity guarantee and
// the round-trip that a mocked PrismaService cannot prove.
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PiiExportAuditService } from './pii-export-audit.service';

const prisma = new PrismaClient();
const service = new PiiExportAuditService(prisma as unknown as PrismaService);

let counter = 0;
const uid = (p: string) => `e1-itest-${p}-${Date.now()}-${++counter}`;

interface Principal {
  merchantId: string;
  userId: string;
}

async function createPrincipal(): Promise<Principal> {
  const merchantId = uid('merchant');
  await prisma.merchant.create({ data: { id: merchantId, jiopayMid: uid('mid'), name: `E-1 itest ${merchantId}`, secretKeyEnc: Buffer.from('unused') } });
  const userId = uid('user');
  await prisma.user.create({ data: { id: userId, merchantId, type: 'EXTERNAL', role: 'MERCHANT_ADMIN', email: `${userId}@example.invalid`, subject: userId } });
  return { merchantId, userId };
}

async function cleanup(p: Principal): Promise<void> {
  await prisma.piiExportAudit.deleteMany({ where: { merchantId: p.merchantId } });
  await prisma.user.deleteMany({ where: { id: p.userId } });
  await prisma.merchant.deleteMany({ where: { id: p.merchantId } });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('PiiExportAuditService.record (real DB)', () => {
  it('creates exactly one row; every field (incl. the filters JSON) round-trips; createdAt is set', async () => {
    const p = await createPrincipal();
    try {
      const before = await prisma.piiExportAudit.count({ where: { merchantId: p.merchantId } });

      const filters = { dateFrom: '2026-08-01', dateTo: '2026-08-31', billType: 'TAX_INVOICE', source: 'DIRECT_API' };
      const result = await service.record({
        merchantId: p.merchantId,
        userId: p.userId,
        rowCount: 137,
        contactProjection: 'full',
        filters,
      });

      expect(await prisma.piiExportAudit.count({ where: { merchantId: p.merchantId } })).toBe(before + 1);

      const row = await prisma.piiExportAudit.findUniqueOrThrow({ where: { id: result.id } });
      expect(row.merchantId).toBe(p.merchantId);
      expect(row.userId).toBe(p.userId);
      expect(row.rowCount).toBe(137);
      expect(row.contactProjection).toBe('full');
      expect(row.filters).toEqual(filters);
      expect(row.createdAt).toBeInstanceOf(Date);
      expect(result.createdAt.getTime()).toBe(row.createdAt.getTime());
    } finally {
      await cleanup(p);
    }
  });

  it('stores {} for an unfiltered export', async () => {
    const p = await createPrincipal();
    try {
      const { id } = await service.record({ merchantId: p.merchantId, userId: p.userId, rowCount: 5, contactProjection: 'masked', filters: {} });
      const row = await prisma.piiExportAudit.findUniqueOrThrow({ where: { id } });
      expect(row.filters).toEqual({});
      expect(row.contactProjection).toBe('masked');
    } finally {
      await cleanup(p);
    }
  });

  it('THE FK-integrity test — a nonexistent userId is REJECTED (P2003), no orphan-principal audit row', async () => {
    const p = await createPrincipal();
    try {
      const err = await service
        .record({ merchantId: p.merchantId, userId: 'user-does-not-exist', rowCount: 1, contactProjection: 'full', filters: {} })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2003');
      expect(await prisma.piiExportAudit.count({ where: { merchantId: p.merchantId } })).toBe(0);
    } finally {
      await cleanup(p);
    }
  });

  it('THE FK-integrity test — a nonexistent merchantId is REJECTED (P2003)', async () => {
    const p = await createPrincipal();
    try {
      const err = await service
        .record({ merchantId: 'merchant-does-not-exist', userId: p.userId, rowCount: 1, contactProjection: 'full', filters: {} })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
      expect((err as Prisma.PrismaClientKnownRequestError).code).toBe('P2003');
    } finally {
      await cleanup(p);
    }
  });

  it('commit==resolved (weak form, D-80 / MAJOR-2): the committed row survives a later thrown error in the same flow', async () => {
    const p = await createPrincipal();
    try {
      const { id } = await service.record({ merchantId: p.merchantId, userId: p.userId, rowCount: 9, contactProjection: 'full', filters: {} });

      // record() has resolved -> the row is committed. Re-read on a fresh query.
      expect(await prisma.piiExportAudit.findUnique({ where: { id } })).not.toBeNull();

      // A subsequent failure in the calling flow (what E-2's stream dying looks
      // like) does NOT roll the audit row back — the full "orphan row, no file"
      // assertion is E-2's, end to end.
      try {
        throw new Error('simulated export-stream failure after the audit commit');
      } catch {
        /* swallow — the point is the row below */
      }
      expect(await prisma.piiExportAudit.findUnique({ where: { id } })).not.toBeNull();
    } finally {
      await cleanup(p);
    }
  });

  it('a rowCount of 0 is recorded (an empty export is still an audited egress act)', async () => {
    const p = await createPrincipal();
    try {
      const { id } = await service.record({ merchantId: p.merchantId, userId: p.userId, rowCount: 0, contactProjection: 'masked', filters: {} });
      expect((await prisma.piiExportAudit.findUniqueOrThrow({ where: { id } })).rowCount).toBe(0);
    } finally {
      await cleanup(p);
    }
  });
});
