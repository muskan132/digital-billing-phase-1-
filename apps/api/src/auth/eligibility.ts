// A-2/A-3 share this rule (D-45: the same eligibility check runs at login AND
// on every subsequent request) — written once so the two call sites cannot
// drift into checking slightly different things.
import { User } from '@prisma/client';

export function isEligibleUser(user: Pick<User, 'type' | 'merchantId' | 'disabledAt'> | null | undefined): boolean {
  if (!user) {
    return false;
  }
  return user.type === 'EXTERNAL' && user.merchantId !== null && user.disabledAt === null;
}
