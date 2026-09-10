import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiKeyGuard } from './api-key.guard';
import { BillsController } from './bills.controller';
import { BillsService } from './bills.service';
import { PortalBillsController } from './portal-bills.controller';
import { PortalBillsService } from './portal-bills.service';
import { PortalDeliveriesController } from './portal-deliveries.controller';
import { PortalDeliveriesService } from './portal-deliveries.service';
import { PiiExportAuditService } from './pii-export-audit.service';

@Module({
  // H-1: AuthModule imported so SessionGuard (used by the portal controllers)
  // can resolve its own constructor dependencies (SessionService, Reflector)
  // — it's a provider exported by AuthModule, not registered here directly.
  imports: [AuthModule],
  controllers: [BillsController, PortalBillsController, PortalDeliveriesController],
  // E-1 (D-70): PiiExportAuditService is registered now, unused until E-2's
  // export route calls it. It has no controller — it is not a route (D-80).
  providers: [ApiKeyGuard, BillsService, PortalBillsService, PortalDeliveriesService, PiiExportAuditService],
  exports: [ApiKeyGuard],
})
export class BillsModule {}
