import { maskEmailPortal, maskMobilePortal } from './portal-contact-mask.util';

describe('maskMobilePortal (D-48)', () => {
  it('matches D-48\'s literal example exactly: first 2, stars, last 4', () => {
    expect(maskMobilePortal('9876543210')).toBe('98****3210');
  });

  it('masks fully when too short to keep 2+4 digits safely', () => {
    expect(maskMobilePortal('12345')).toBe('*****');
    expect(maskMobilePortal('123456')).toBe('******');
  });

  it('returns null (not a placeholder string) when absent', () => {
    expect(maskMobilePortal(undefined)).toBeNull();
    expect(maskMobilePortal(null)).toBeNull();
    expect(maskMobilePortal('')).toBeNull();
  });
});

describe('maskEmailPortal (D-48)', () => {
  it('matches D-48\'s literal example exactly: first local char, stars, full domain', () => {
    expect(maskEmailPortal('anna@example.com')).toBe('a***@example.com');
  });

  it('returns null when absent', () => {
    expect(maskEmailPortal(undefined)).toBeNull();
    expect(maskEmailPortal(null)).toBeNull();
  });
});
