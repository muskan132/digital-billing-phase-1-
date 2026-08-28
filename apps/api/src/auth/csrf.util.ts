// A-5 / D-57: synchronizer token, derived, never stored. Deriving from the
// session token itself (rather than persisting a second random value) means
// the CSRF token is exactly as revocable as the session — the moment the
// session token stops validating, this HMAC is meaningless too, with no
// separate row to clean up or forget.
import { createHmac, timingSafeEqual } from 'crypto';

function getSecret(): string {
  const secret = process.env.CSRF_SECRET;
  if (!secret) {
    throw new Error('CSRF_SECRET env var is required (D-57) — see apps/api/.env.example');
  }
  return secret;
}

export function deriveCsrfToken(sessionToken: string): string {
  return createHmac('sha256', getSecret()).update(sessionToken).digest('hex');
}

export function isValidCsrfToken(sessionToken: string, providedToken: string | undefined): boolean {
  if (!providedToken) {
    return false;
  }
  const expected = Buffer.from(deriveCsrfToken(sessionToken), 'hex');
  const provided = Buffer.from(providedToken, 'hex');
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
