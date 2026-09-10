import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { MerchantContext } from '../auth/merchant-context';
import { SessionGuard } from '../auth/session.guard';
import { SessionService } from '../auth/session.service';
import { PortalBillsController } from './portal-bills.controller';
import { PortalBillsService } from './portal-bills.service';
import { PortalDeliveriesService } from './portal-deliveries.service';
import { PiiExportAuditService } from './pii-export-audit.service';

const CTX: MerchantContext = { userId: 'user-1', merchantId: 'merchant-A', role: 'MERCHANT_ADMIN' as never };

describe('PortalBillsController.resend (R-2)', () => {
  it("delegates to PortalDeliveriesService.resend with the caller's merchantId and the path bill id — no body", async () => {
    const resend = jest.fn().mockResolvedValue({ resent: true, channel: 'EMAIL' });
    const controller = new PortalBillsController(
      {} as unknown as PortalBillsService,
      { resend } as unknown as PortalDeliveriesService,
      {} as unknown as PiiExportAuditService,
    );

    const result = await controller.resend('bill-1', CTX);

    expect(resend).toHaveBeenCalledWith('merchant-A', 'bill-1');
    expect(result).toEqual({ resent: true, channel: 'EMAIL' });
  });
});

// D-59 / D-69: resend is MERCHANT_ADMIN only (method-level override of the
// class read-tier). Real Nest app, real SessionGuard, real Reflector.
class FakeSessionServiceForRole {
  async findActiveSession(token: string) {
    return { user: { id: 'user-1', merchantId: 'merchant-A', type: 'EXTERNAL', role: token, disabledAt: null } };
  }
}

const FAKE_BILLS_SERVICE = {
  list: async () => ({ items: [], nextCursor: null }),
  findOne: async () => ({ id: 'bill-1' }),
  exportRows: async () => [],
};
const FAKE_DELIVERIES_SERVICE = { resend: async () => ({ resent: true, channel: 'EMAIL' }) };
const FAKE_AUDIT_SERVICE = {
  record: jest.fn((_input: unknown) => Promise.resolve({ id: 'audit-1', createdAt: new Date() })),
};

describe('PortalBillsController (structural — real Nest app, real SessionGuard)', () => {
  let app: import('@nestjs/common').INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PortalBillsController],
      providers: [
        { provide: PortalBillsService, useValue: FAKE_BILLS_SERVICE },
        { provide: PortalDeliveriesService, useValue: FAKE_DELIVERIES_SERVICE },
        { provide: PiiExportAuditService, useValue: FAKE_AUDIT_SERVICE },
        { provide: SessionService, useClass: FakeSessionServiceForRole },
        { provide: APP_GUARD, useClass: SessionGuard },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET routes accept BOTH MERCHANT_ADMIN and STORE_STAFF (read-tier)', async () => {
    for (const role of ['MERCHANT_ADMIN', 'STORE_STAFF']) {
      const list = await fetch(`${baseUrl}/portal/bills`, { headers: { cookie: `session=${role}` } });
      const detail = await fetch(`${baseUrl}/portal/bills/bill-1`, { headers: { cookie: `session=${role}` } });
      expect(list.status).toBe(200);
      expect(detail.status).toBe(200);
    }
  });

  it('POST /portal/bills/:id/resend — MERCHANT_ADMIN → 201', async () => {
    const res = await fetch(`${baseUrl}/portal/bills/bill-1/resend`, { method: 'POST', headers: { cookie: 'session=MERCHANT_ADMIN' } });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ resent: true, channel: 'EMAIL' });
  });

  it('POST /portal/bills/:id/resend — STORE_STAFF → 403 (write-tier, not the class read default)', async () => {
    const res = await fetch(`${baseUrl}/portal/bills/bill-1/resend`, { method: 'POST', headers: { cookie: 'session=STORE_STAFF' } });
    expect(res.status).toBe(403);
  });

  it('POST /portal/bills/:id/resend — no session → 401', async () => {
    const res = await fetch(`${baseUrl}/portal/bills/bill-1/resend`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('a body carrying a recipient reaches no handler param — the route has no @Body, so it is inert', async () => {
    const res = await fetch(`${baseUrl}/portal/bills/bill-1/resend`, {
      method: 'POST',
      headers: { cookie: 'session=MERCHANT_ADMIN', 'content-type': 'application/json' },
      body: JSON.stringify({ recipient: 'attacker@evil.com' }),
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ resent: true, channel: 'EMAIL' });
  });

  // E-2 / D-71: export is MERCHANT_ADMIN only; STORE_STAFF → 403 for BOTH
  // projections with zero audit rows.
  it('GET /portal/bills/export.csv — STORE_STAFF → 403 on both projections, auditService.record NOT called', async () => {
    FAKE_AUDIT_SERVICE.record.mockClear();
    for (const contact of ['masked', 'full']) {
      const res = await fetch(`${baseUrl}/portal/bills/export.csv?contact=${contact}`, { headers: { cookie: 'session=STORE_STAFF' } });
      expect(res.status).toBe(403);
    }
    expect(FAKE_AUDIT_SERVICE.record).not.toHaveBeenCalled();
  });

  it('GET /portal/bills/export.csv — MERCHANT_ADMIN, no contact param → 422 INVALID_CONTACT_PARAM, record NOT called (zero DB)', async () => {
    FAKE_AUDIT_SERVICE.record.mockClear();
    const res = await fetch(`${baseUrl}/portal/bills/export.csv`, { headers: { cookie: 'session=MERCHANT_ADMIN' } });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error_code: string }).error_code).toBe('INVALID_CONTACT_PARAM');
    expect(FAKE_AUDIT_SERVICE.record).not.toHaveBeenCalled();
  });

  it('GET /portal/bills/export.csv — MERCHANT_ADMIN, contact=masked → 200 text/csv, and record() awaited before the body', async () => {
    FAKE_AUDIT_SERVICE.record.mockClear();
    const res = await fetch(`${baseUrl}/portal/bills/export.csv?contact=masked`, { headers: { cookie: 'session=MERCHANT_ADMIN' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(res.headers.get('content-disposition')).toMatch(/attachment; filename=/);
    expect(FAKE_AUDIT_SERVICE.record).toHaveBeenCalledTimes(1);
    expect(FAKE_AUDIT_SERVICE.record.mock.calls[0][0]).toMatchObject({ merchantId: 'merchant-A', userId: 'user-1', rowCount: 0, contactProjection: 'masked' });
  });

  it('GET /portal/bills/export.csv — record() rejects → plain 500, no CSV body', async () => {
    FAKE_AUDIT_SERVICE.record.mockClear();
    FAKE_AUDIT_SERVICE.record.mockRejectedValueOnce(new Error('audit write failed'));
    const res = await fetch(`${baseUrl}/portal/bills/export.csv?contact=full`, { headers: { cookie: 'session=MERCHANT_ADMIN' } });
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).not.toMatch(/text\/csv/);
  });
});
