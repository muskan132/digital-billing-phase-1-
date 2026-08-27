// D-46: the ONE shape that answers "which merchant is this request for".
// SessionGuard populates this from a real session; DemoOnlyGuard (A-4) is
// the other resolver, populating it from the seed merchant's fixed id. Every
// merchant-scoped service takes merchantId as an argument — never reads
// either guard or the environment directly.
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { UserRole } from '@prisma/client';

export interface MerchantContext {
  userId: string;
  merchantId: string;
  role: UserRole;
}

export const CurrentMerchantContext = createParamDecorator((_data: unknown, ctx: ExecutionContext): MerchantContext => {
  const request = ctx.switchToHttp().getRequest();
  return request.merchantContext;
});
