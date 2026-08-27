import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { DemoOnlyGuard } from './demo-only.guard';

function makeContext(): { context: ExecutionContext; request: Record<string, unknown> } {
  const request: Record<string, unknown> = {};
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('DemoOnlyGuard', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('throws 404 when NODE_ENV=production, so the demo panel is invisible in prod', () => {
    process.env.NODE_ENV = 'production';
    const { context } = makeContext();
    expect(() => new DemoOnlyGuard().canActivate(context)).toThrow(NotFoundException);
  });

  it('allows the request through in every non-production environment', () => {
    process.env.NODE_ENV = 'development';
    expect(new DemoOnlyGuard().canActivate(makeContext().context)).toBe(true);
    process.env.NODE_ENV = 'test';
    expect(new DemoOnlyGuard().canActivate(makeContext().context)).toBe(true);
    delete process.env.NODE_ENV;
    expect(new DemoOnlyGuard().canActivate(makeContext().context)).toBe(true);
  });

  it('attaches a MerchantContext (D-46) matching the seeded merchant admin', () => {
    const { context, request } = makeContext();
    new DemoOnlyGuard().canActivate(context);
    expect(request.merchantContext).toEqual({
      userId: 'seed-user-merchant-admin',
      merchantId: 'seed-merchant-demo',
      role: 'MERCHANT_ADMIN',
    });
  });
});
