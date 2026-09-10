// E-2 / D-70 / D-80 / D-81: real-Postgres coverage for the two guarantees that
// only exist end to end —
//   1. the committed PiiExportAudit row's rowCount === the file's data-row count
//      and its projection === the file produced (D-70).
//   2. a forced serializer failure AFTER record() commits leaves an ORPHAN
//      audit row and NO file (D-80 §3 — E-1 deferred this to E-2).
// Plus: contact omitted → 422, zero audit rows; cross-merchant → only the
// session merchant's rows, cross-checked against a raw count.
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PortalBillsController } from './portal-bills.controller';
import { PortalBillsService, buildBillFilterWhere } from './portal-bills.service';
import { PortalDeliveriesService } from './portal-deliveries.service';
import { PiiExportAuditService } from './pii-export-audit.service';
import * as csvUtil from './bills-export-csv.util';

const prisma = new PrismaClient();
const billsService = new PortalBillsService(prisma as unknown as PrismaService);
const auditService = new PiiExportAuditService(prisma as unknown as PrismaService);
const controller = new PortalBillsController(billsService, {} as unknown as PortalDeliveriesService, auditService);

let counter = 0;
const uid = (p: string) => `e2-itest-${p}-${Date.now()}-${++counter}`;

interface Scratch {
  merchantId: string;
  userId: string;
  templateId: string;
}

async function createScratch(): Promise<Scratch> {
  const merchantId = uid('merchant');
  await prisma.merchant.create({ data: { id: merchantId, jiopayMid: uid('mid'), name: `E-2 itest ${merchantId}`, secretKeyEnc: Buffer.from('x') } });
  const userId = uid('user');
  await prisma.user.create({ data: { id: userId, merchantId, type: 'EXTERNAL', role: 'MERCHANT_ADMIN', email: `${userId}@example.invalid`, subject: userId } });
  const templateId = uid('tpl');
  await prisma.template.create({ data: { id: templateId, merchantId, name: uid('T'), billType: 'RECEIPT', layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] }, isHead: true } });
  return { merchantId, userId, templateId };
}

async function addBill(s: Scratch, opts: { mobile?: string; email?: string; broadcastStatus?: 'PENDING' | 'SENT' | 'FAILED' } = {}) {
  const orderId = uid('order');
  await prisma.order.create({
    data: { id: orderId, merchantId: s.merchantId, status: 'SUCCESS', externalTransactionId: uid('ext'), rawCallback: {}, customerMobile_pii: opts.mobile, customerEmail_pii: opts.email },
  });
  if (opts.broadcastStatus) {
    await prisma.broadcast.create({ data: { orderId, channel: 'EMAIL', recipient: opts.email ?? 'x@example.com', status: opts.broadcastStatus, ...(opts.broadcastStatus === 'SENT' ? { sentAt: new Date() } : {}) } });
  }
  return prisma.bill.create({ data: { id: uid('bill'), orderId, merchantId: s.merchantId, billType: 'RECEIPT', templateId: s.templateId, totalPaise: 100n, snapshot: {} } });
}

async function cleanup(s: Scratch) {
  const orderIds = (await prisma.order.findMany({ where: { merchantId: s.merchantId }, select: { id: true } })).map((o) => o.id);
  await prisma.broadcast.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.piiExportAudit.deleteMany({ where: { merchantId: s.merchantId } });
  await prisma.bill.deleteMany({ where: { merchantId: s.merchantId } });
  await prisma.order.deleteMany({ where: { merchantId: s.merchantId } });
  await prisma.user.deleteMany({ where: { id: s.userId } });
  await prisma.template.deleteMany({ where: { merchantId: s.merchantId } });
  await prisma.merchant.deleteMany({ where: { id: s.merchantId } });
}

// Captures what the controller does to the express response.
function fakeRes() {
  const captured: { status?: number; headers: Record<string, string>; body?: string } = { headers: {} };
  return {
    res: {
      status: (c: number) => { captured.status = c; },
      setHeader: (n: string, v: string) => { captured.headers[n.toLowerCase()] = v; },
      send: (b: string) => { captured.body = b; },
    },
    captured,
  };
}

const ctxOf = (s: Scratch) => ({ userId: s.userId, merchantId: s.merchantId, role: 'MERCHANT_ADMIN' as never });

afterAll(async () => {
  await prisma.$disconnect();
});

describe('E-2 CSV export (real DB)', () => {
  it('THE rowCount test — the committed audit row rowCount === the file data-row count, projection === produced', async () => {
    const s = await createScratch();
    try {
      await addBill(s, { mobile: '9111111111', email: 'a@ex.com', broadcastStatus: 'SENT' });
      await addBill(s, { mobile: '9222222222', email: 'b@ex.com', broadcastStatus: 'FAILED' });
      await addBill(s, {}); // no contact, no broadcast

      const { res, captured } = fakeRes();
      const auditBefore = await prisma.piiExportAudit.count({ where: { merchantId: s.merchantId } });

      await controller.exportCsv({ contact: 'masked' }, ctxOf(s), res);

      expect(captured.status).toBe(200);
      expect(captured.headers['content-type']).toMatch(/text\/csv/);

      const lines = captured.body!.trimEnd().split('\r\n');
      const dataRows = lines.length - 1; // minus the header
      expect(dataRows).toBe(3);

      const audits = await prisma.piiExportAudit.findMany({ where: { merchantId: s.merchantId } });
      expect(audits).toHaveLength(auditBefore + 1);
      expect(audits[0].rowCount).toBe(dataRows);
      expect(audits[0].contactProjection).toBe('masked');
      expect(audits[0].userId).toBe(s.userId);

      // masked: no raw contact anywhere
      expect(captured.body).not.toContain('9111111111');
      expect(captured.body).not.toContain('a@ex.com');
    } finally {
      await cleanup(s);
    }
  });

  it('THE D-80 §3 orphan-row test — serializer throws AFTER the audit commits → 500, no file, orphan audit row remains', async () => {
    const s = await createScratch();
    const spy = jest.spyOn(csvUtil, 'serializeBillsCsv').mockImplementation(() => {
      throw new Error('forced serializer failure after the audit commit');
    });
    try {
      await addBill(s, { email: 'c@ex.com' });
      await addBill(s, { email: 'd@ex.com' });

      const { res, captured } = fakeRes();
      const err = await controller.exportCsv({ contact: 'full' }, ctxOf(s), res).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(Error);
      expect(captured.body).toBeUndefined(); // NO file bytes
      expect(captured.headers['content-type']).toBeUndefined();

      // the audit row committed BEFORE the serializer ran — it is orphaned.
      const audits = await prisma.piiExportAudit.findMany({ where: { merchantId: s.merchantId } });
      expect(audits).toHaveLength(1);
      expect(audits[0].rowCount).toBe(2);
      expect(audits[0].contactProjection).toBe('full');
    } finally {
      spy.mockRestore();
      await cleanup(s);
    }
  });

  it('contact omitted / unrecognised → 422 INVALID_CONTACT_PARAM, ZERO audit rows, no query, no file', async () => {
    const s = await createScratch();
    try {
      await addBill(s, { email: 'e@ex.com' });
      const exportRowsSpy = jest.spyOn(billsService, 'exportRows');

      for (const bad of [undefined, 'MASKED', 'both', '']) {
        const { res, captured } = fakeRes();
        const err = await controller.exportCsv({ contact: bad as string | undefined }, ctxOf(s), res).catch((e: unknown) => e);
        expect((err as { getResponse: () => unknown }).getResponse()).toMatchObject({ error_code: 'INVALID_CONTACT_PARAM' });
        expect(captured.body).toBeUndefined();
      }
      expect(exportRowsSpy).not.toHaveBeenCalled(); // zero DB activity
      expect(await prisma.piiExportAudit.count({ where: { merchantId: s.merchantId } })).toBe(0);
      exportRowsSpy.mockRestore();
    } finally {
      await cleanup(s);
    }
  });

  it('cross-merchant — the file contains ONLY the session merchant\'s rows, cross-checked against a raw count', async () => {
    const a = await createScratch();
    const b = await createScratch();
    try {
      await addBill(a, { email: 'a-cust@ex.com' });
      await addBill(a, { email: 'a-cust2@ex.com' });
      await addBill(b, { email: 'b-cust@ex.com' });

      const { res, captured } = fakeRes();
      await controller.exportCsv({ contact: 'full' }, ctxOf(a), res);

      const dataRows = captured.body!.trimEnd().split('\r\n').length - 1;
      const rawCount = await prisma.bill.count({ where: buildBillFilterWhere(a.merchantId, {}) });
      expect(dataRows).toBe(rawCount);
      expect(dataRows).toBe(2);
      expect(captured.body).not.toContain('b-cust@ex.com');
      expect(captured.body).toContain('a-cust@ex.com'); // full projection → raw
    } finally {
      await cleanup(a);
      await cleanup(b);
    }
  });

  it('the audit filters JSON records exactly the query params the merchant sent, as strings', async () => {
    const s = await createScratch();
    try {
      await addBill(s, {});
      const { res } = fakeRes();
      await controller.exportCsv({ contact: 'masked', billType: 'RECEIPT', dateFrom: '2020-01-01' }, ctxOf(s), res);
      const audit = await prisma.piiExportAudit.findFirstOrThrow({ where: { merchantId: s.merchantId } });
      expect(audit.filters).toEqual({ billType: 'RECEIPT', dateFrom: '2020-01-01' });
    } finally {
      await cleanup(s);
    }
  });

  it('an unfiltered export records filters: {}', async () => {
    const s = await createScratch();
    try {
      await addBill(s, {});
      const { res } = fakeRes();
      await controller.exportCsv({ contact: 'full' }, ctxOf(s), res);
      const audit = await prisma.piiExportAudit.findFirstOrThrow({ where: { merchantId: s.merchantId } });
      expect(audit.filters).toEqual({});
    } finally {
      await cleanup(s);
    }
  });
});
