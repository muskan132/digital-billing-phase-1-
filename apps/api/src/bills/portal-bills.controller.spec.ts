import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { MerchantContext } from '../auth/merchant-context';
import { SessionGuard } from '../auth/session.guard';
import { SessionService } from '../auth/session.service';
import { PortalBillsController } from './portal-bills.controller';
import { PortalBillsService } from './portal-bills.service';
import { PortalDeliveriesService } from './portal-deliveries.service';

const CTX: MerchantContext = { userId: 'user-1', merchantId: 'merchant-A', role: 'MERCHANT_ADMIN' as never };

describe('PortalBillsController.resend (R-2)', () => {
  it("delegates to PortalDeliveriesService.resend with the caller's merchantId and the path bill id — no body", async () => {
    const resend = jest.fn().mockResolvedValue({ resent: true, channel: 'EMAIL' });
    const controller = new PortalBillsController({} as unknown as PortalBillsService, { resend } as unknown as PortalDeliveriesService);

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

const FAKE_BILLS_SERVICE = { list: async () => ({ items: [], nextCursor: null }), findOne: async () => ({ id: 'bill-1' }) };
const FAKE_DELIVERIES_SERVICE = { resend: async () => ({ resent: true, channel: 'EMAIL' }) };

describe('PortalBillsController (structural — real Nest app, real SessionGuard)', () => {
  let app: import('@nestjs/common').INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PortalBillsController],
      providers: [
        { provide: PortalBillsService, useValue: FAKE_BILLS_SERVICE },
        { provide: PortalDeliveriesService, useValue: FAKE_DELIVERIES_SERVICE },
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
});
