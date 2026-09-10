import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { MerchantContext } from '../auth/merchant-context';
import { SessionGuard } from '../auth/session.guard';
import { SessionService } from '../auth/session.service';
import { PortalDeliveriesController } from './portal-deliveries.controller';
import { PortalDeliveriesService } from './portal-deliveries.service';

const CTX: MerchantContext = { userId: 'user-1', merchantId: 'merchant-A', role: 'MERCHANT_ADMIN' as never };

describe('PortalDeliveriesController (R-1)', () => {
  it("passes the caller's own MerchantContext.merchantId to the service, never a request field", async () => {
    const getDeliveries = jest.fn().mockResolvedValue({ counts: { PENDING: 0, SENT: 0, FAILED: 0 }, maxAttempts: 5, failed: [] });
    const controller = new PortalDeliveriesController({ getDeliveries } as unknown as PortalDeliveriesService);

    const result = await controller.list(CTX);

    expect(getDeliveries).toHaveBeenCalledWith('merchant-A');
    expect(result).toEqual({ counts: { PENDING: 0, SENT: 0, FAILED: 0 }, maxAttempts: 5, failed: [] });
  });
});

// D-50 / D-59: read-tier — MERCHANT_ADMIN AND STORE_STAFF both reach the route.
// Real Nest app, real SessionGuard, real Reflector — not a mocked reflector
// (the D-59 lesson).
class FakeSessionServiceForRole {
  async findActiveSession(token: string) {
    return { user: { id: 'user-1', merchantId: 'merchant-A', type: 'EXTERNAL', role: token, disabledAt: null } };
  }
}

const FAKE_DELIVERIES_SERVICE = {
  getDeliveries: async () => ({ counts: { PENDING: 0, SENT: 0, FAILED: 0 }, maxAttempts: 5, failed: [] }),
};

describe('PortalDeliveriesController (structural — real Nest app, real SessionGuard)', () => {
  let app: import('@nestjs/common').INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PortalDeliveriesController],
      providers: [
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

  it('GET /portal/deliveries accepts BOTH MERCHANT_ADMIN and STORE_STAFF (read-tier)', async () => {
    for (const role of ['MERCHANT_ADMIN', 'STORE_STAFF']) {
      const res = await fetch(`${baseUrl}/portal/deliveries`, { headers: { cookie: `session=${role}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { maxAttempts: number };
      expect(body.maxAttempts).toBe(5);
    }
  });

  it('rejects an unknown role with 403', async () => {
    const res = await fetch(`${baseUrl}/portal/deliveries`, { headers: { cookie: 'session=OPS_SUPPORT' } });
    expect(res.status).toBe(403);
  });

  it('rejects a missing session with 401', async () => {
    const res = await fetch(`${baseUrl}/portal/deliveries`);
    expect(res.status).toBe(401);
  });
});
