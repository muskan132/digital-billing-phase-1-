import { ExecutionContext, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SessionGuard } from './session.guard';
import { SessionService } from './session.service';

function makeContext(
  cookieHeader: string | undefined,
  requiredRoles?: string[],
): { context: ExecutionContext; request: Record<string, unknown>; clearCookie: jest.Mock } {
  const request: Record<string, unknown> = { headers: { cookie: cookieHeader } };
  const clearCookie = jest.fn();
  const context = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({ clearCookie }),
    }),
    getHandler: () => ({}),
  } as unknown as ExecutionContext;
  // Attach requiredRoles via the mocked Reflector below instead of context itself.
  void requiredRoles;
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
  let reflectorGet: jest.Mock;
  let guard: SessionGuard;

  beforeEach(() => {
    findActiveSession = jest.fn();
    reflectorGet = jest.fn().mockReturnValue(undefined);
    const sessions = { findActiveSession } as unknown as SessionService;
    const reflector = { get: reflectorGet } as unknown as Reflector;
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
    reflectorGet.mockReturnValue(['MERCHANT_ADMIN']);
    const { context, clearCookie } = makeContext('session=some-token');

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException);
    expect(clearCookie).not.toHaveBeenCalled();
  });

  it('accepts a role that IS in the required list', async () => {
    findActiveSession.mockResolvedValue({ user: ELIGIBLE_USER });
    reflectorGet.mockReturnValue(['MERCHANT_ADMIN', 'STORE_STAFF']);
    const { context } = makeContext('session=some-token');

    await expect(guard.canActivate(context)).resolves.toBe(true);
  });
});
