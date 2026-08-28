// W-1: validates the `returnTo` query param on /auth/login so a successful
// login can redirect back to the originally requested /portal path, without
// letting the param be used as an open redirect off /portal.
export function isSafeReturnTo(value: string | undefined): value is string {
  return typeof value === 'string' && value.startsWith('/portal');
}
