import { NotFoundException } from '@nestjs/common';
import { DemoOnlyGuard } from './demo-only.guard';

describe('DemoOnlyGuard', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });

  it('throws 404 when NODE_ENV=production, so the demo panel is invisible in prod', () => {
    process.env.NODE_ENV = 'production';
    expect(() => new DemoOnlyGuard().canActivate()).toThrow(NotFoundException);
  });

  it('allows the request through in every non-production environment', () => {
    process.env.NODE_ENV = 'development';
    expect(new DemoOnlyGuard().canActivate()).toBe(true);
    process.env.NODE_ENV = 'test';
    expect(new DemoOnlyGuard().canActivate()).toBe(true);
    delete process.env.NODE_ENV;
    expect(new DemoOnlyGuard().canActivate()).toBe(true);
  });
});
