// R-1: GET /portal/deliveries. SessionGuard resolves MerchantContext and
// re-checks eligibility every request (D-45); @Roles per D-50 — delivery
// visibility is a READ (the masked recipient shown here is a strict subset of
// what STORE_STAFF already sees in GET /portal/bills), so MERCHANT_ADMIN +
// STORE_STAFF, same as the bill history. The write action (R-2 resend) is
// MERCHANT_ADMIN only — that asymmetry belongs to R-2, not here.
import { Controller, Get, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { SessionGuard } from '../auth/session.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentMerchantContext, MerchantContext } from '../auth/merchant-context';
import { PortalDeliveriesResult, PortalDeliveriesService } from './portal-deliveries.service';

@Controller('portal/deliveries')
@UseGuards(SessionGuard)
@Roles(UserRole.MERCHANT_ADMIN, UserRole.STORE_STAFF)
export class PortalDeliveriesController {
  constructor(private readonly deliveriesService: PortalDeliveriesService) {}

  @Get()
  async list(@CurrentMerchantContext() ctx: MerchantContext): Promise<PortalDeliveriesResult> {
    return this.deliveriesService.getDeliveries(ctx.merchantId);
  }
}
