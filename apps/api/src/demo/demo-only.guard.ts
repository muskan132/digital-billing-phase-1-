import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { MerchantContext } from '../auth/merchant-context';

// A-4/D-46: this is the ONE place SEED_MERCHANT_ID is read anywhere in
// apps/api. Every merchant-scoped service takes merchantId as an argument,
// resolved from MerchantContext — never from this constant or the
// environment directly. SessionGuard (A-3) is the other MerchantContext
// resolver, for real /portal sessions.
const SEED_MERCHANT_ID = 'seed-merchant-demo';
// Matches apps/api/prisma/seed.ts's USER_MERCHANT_ADMIN_ID exactly — the one
// seeded EXTERNAL/MERCHANT_ADMIN user the whole demo surface has always
// implicitly assumed. Real values, not fabricated, so MerchantContext stays
// one uniform, always-fully-populated shape regardless of which guard
// produced it (D-39's reasoning: no optional-field-dependent second shape).
const SEED_USER_ID = 'seed-user-merchant-admin';

// The demo control panel can mint valid signed PG callbacks and post real
// invoices on demand — a genuine forgery surface if it ever reached
// production. 404, not 403: a hidden route should look absent, not
// merely locked.
@Injectable()
export class DemoOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    if (process.env.NODE_ENV === 'production') {
      throw new NotFoundException();
    }

    const request = context.switchToHttp().getRequest<{ merchantContext?: MerchantContext }>();
    request.merchantContext = {
      userId: SEED_USER_ID,
      merchantId: SEED_MERCHANT_ID,
      role: 'MERCHANT_ADMIN',
    };

    return true;
  }
}
