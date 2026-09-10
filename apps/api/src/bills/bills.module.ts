import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiKeyGuard } from './api-key.guard';
import { BillsController } from './bills.controller';
import { BillsService } from './bills.service';
import { PortalBillsController } from './portal-bills.controller';
import { PortalBillsService } from './portal-bills.service';
import { PortalDeliveriesController } from './portal-deliveries.controller';
import { PortalDeliveriesService } from './portal-deliveries.service';

@Module({
  // H-1: AuthModule imported so SessionGuard (used by the portal controllers)
  // can resolve its own constructor dependencies (SessionService, Reflector)
  // — it's a provider exported by AuthModule, not registered here directly.
  imports: [AuthModule],
  controllers: [BillsController, PortalBillsController, PortalDeliveriesController],
  providers: [ApiKeyGuard, BillsService, PortalBillsService, PortalDeliveriesService],
  exports: [ApiKeyGuard],
})
export class BillsModule {}
