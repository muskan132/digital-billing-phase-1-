import { Controller, ExecutionContext, ForbiddenException, Get, INestApplication, UnauthorizedException, UseGuards } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';
import { Roles } from './roles.decorator';

function makeContext(
  cookieHeader: string | undefined,
): { context: ExecutionContext; request: Record<string, unknown>; clearCookie: jest.Mock } {
  const request: Record<string, unknown> = { headers: { cookie: cookieHeader } };
  const clearCookie = jest.fn();
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ clearCookie }),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
  return { context, request, clearCookie };
}

const ELIGIBLE_USER = {
  id: 'user-1',
  merchantId: 'merchant-1',
  type: 'EXTERNAL',
  role: 'MERCHANT_ADMIN',
  disabledAt: null,
};

describe('SessionGuard', () => {
  let findActiveSession: jest.Mock;
  let reflectorGetAllAndOverride: jest.Mock;
  let guard: SessionGuard;

  beforeEach(() => {
    findActiveSession = jest.fn();
    reflectorGetAllAndOverride = jest.fn().mockReturnValue(undefined);
    const sessions = { findActiveSession } as unknown as SessionService;
    const reflector = { getAllAndOverride: reflectorGetAllAndOverride } as unknown as Reflector;
    guard = new SessionGuard(sessions, reflector);
  });

  it('rejects with 401 and clears the cookie when there is no session cookie at all', async () => {
    const { context, clearCookie } = makeContext(undefined);
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(clearCookie).toHaveBeenCalledWith('session', { path: '/' });
    expect(findActiveSession).not.toHaveBeenCalled();
  });

  it('rejects with 401 and clears the cookie for an unknown/expired/revoked token', async () => {
    findActiveSession.mockResolvedValue(null); // SessionService collapses unknown/expired/revoked to null
    const { context, clearCookie } = makeContext('session=some-token');
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(clearCookie).toHaveBeenCalledWith('session', { path: '/' });
  });

  it('rejects with 401 and clears the cookie when the user became ineligible mid-session (disabled)', async () => {
    findActiveSession.mockResolvedValue({ user: { ...ELIGIBLE_USER, disabledAt: new Date() } });
    const { context, clearCookie } = makeContext('session=some-token');
    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(clearCookie).toHaveBeenCalledWith('session', { path: '/' });
  });

  it('accepts an eligible session with no role requirement and attaches MerchantContext', async () => {
    findActiveSession.mockResolvedValue({ user: ELIGIBLE_USER });
    const { context, request, clearCookie } = makeContext('session=some-token');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(clearCookie).not.toHaveBeenCalled();
    expect(request.merchantContext).toEqual({
      userId: 'user-1',
      merchantId: 'merchant-1',
      role: 'MERCHANT_ADMIN',
    });
  });

  it('rejects with 403 (session left intact, cookie NOT cleared) when the role does not match the route', async () => {
    findActiveSession.mockResolvedValue({ user: { ...ELIGIBLE_USER, role: 'STORE_STAFF' } });
    reflectorGetAllAndOverride.mockReturnValue(['MERCHANT_ADMIN']);
    const { context, clearCookie } = makeContext('session=some-token');

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(clearCookie).not.toHaveBeenCalled();
  });

  it('accepts a role that IS in the required list', async () => {
    findActiveSession.mockResolvedValue({ user: ELIGIBLE_USER });
    reflectorGetAllAndOverride.mockReturnValue(['MERCHANT_ADMIN', 'STORE_STAFF']);
    const { context } = makeContext('session=some-token');

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });

  it('reads role metadata from BOTH the handler and the class (getAllAndOverride), not the handler alone', async () => {
    findActiveSession.mockResolvedValue({ user: ELIGIBLE_USER });
    const { context } = makeContext('session=some-token');

    await guard.canActivate(context);

    expect(reflectorGetAllAndOverride).toHaveBeenCalledWith('roles', [context.getHandler(), context.getClass()]);
  });
});

// D-59: the mocked tests above prove the guard's OWN role-check logic is
// correct once it's given a role list — they do NOT prove a real
// class-level @Roles() decorator ever reaches that logic, which is exactly
// what shipped broken (D-59's bug). This block bootstraps a REAL Nest app
// with a REAL Reflector against a controller carrying both a class-level
// and a method-level @Roles(), over real HTTP — the same structural-test
// standard csrf.guard.spec.ts already holds itself to.
@Controller('probe')
@UseGuards(SessionGuard)
@Roles(UserRole.MERCHANT_ADMIN, UserRole.STORE_STAFF)
class RoleProbeController {
  // Class-level only: MERCHANT_ADMIN or STORE_STAFF.
  @Get('read')
  read() {
    return { ok: true };
  }

  // Method-level override: MERCHANT_ADMIN only, even though the class says
  // MERCHANT_ADMIN + STORE_STAFF — proves method-level wins, per D-59.
  @Get('write')
  @Roles(UserRole.MERCHANT_ADMIN)
  write() {
    return { ok: true };
  }
}

// A fake SessionService that "authenticates" any cookie value as a user
// with that value as their role — lets each request pick its own role via
// the cookie, no real DB needed for this structural proof.
class FakeSessionService {
  async findActiveSession(token: string) {
    return {
      user: { id: 'user-1', merchantId: 'merchant-1', type: 'EXTERNAL', role: token, disabledAt: null },
    };
  }
}

describe('SessionGuard (structural — real Nest app, real Reflector, D-59)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RoleProbeController],
      providers: [
        { provide: SessionService, useClass: FakeSessionService },
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

  it('a class-level-only route accepts BOTH MERCHANT_ADMIN and STORE_STAFF (H-1/W-2 regression — unchanged behavior, now actually enforced)', async () => {
    const asAdmin = await fetch(`${baseUrl}/probe/read`, { headers: { cookie: 'session=MERCHANT_ADMIN' } });
    const asStaff = await fetch(`${baseUrl}/probe/read`, { headers: { cookie: 'session=STORE_STAFF' } });
    expect(asAdmin.status).toBe(200);
    expect(asStaff.status).toBe(200);
  });

  it('a method-level @Roles() overrides the class-level one — STORE_STAFF is rejected on the write route (W-3)', async () => {
    const asAdmin = await fetch(`${baseUrl}/probe/write`, { headers: { cookie: 'session=MERCHANT_ADMIN' } });
    const asStaff = await fetch(`${baseUrl}/probe/write`, { headers: { cookie: 'session=STORE_STAFF' } });
    expect(asAdmin.status).toBe(200);
    expect(asStaff.status).toBe(403);
  });
});
