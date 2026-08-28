import { isSafeReturnTo } from './return-to.util';

describe('isSafeReturnTo', () => {
  it('accepts a /portal path', () => {
    expect(isSafeReturnTo('/portal')).toBe(true);
    expect(isSafeReturnTo('/portal/bills/abc123')).toBe(true);
  });

  it('rejects a path outside /portal', () => {
    expect(isSafeReturnTo('/v1/bills')).toBe(false);
    expect(isSafeReturnTo('/')).toBe(false);
  });

  it('rejects a protocol-relative or absolute URL (open-redirect attempt)', () => {
    expect(isSafeReturnTo('//evil.com')).toBe(false);
    expect(isSafeReturnTo('https://evil.com/portal')).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isSafeReturnTo(undefined)).toBe(false);
  });
});
