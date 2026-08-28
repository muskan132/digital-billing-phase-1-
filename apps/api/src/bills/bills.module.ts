import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ApiKeyGuard } from './api-key.guard';
import { BillsController } from './bills.controller';
import { BillsService } from './bills.service';
import { PortalBillsController } from './portal-bills.controller';
import { PortalBillsService } from './portal-bills.service';

@Module({
  // H-1: AuthModule imported so SessionGuard (used by PortalBillsController)
  // can resolve its own constructor dependencies (SessionService, Reflector)
  // — it's a provider exported by AuthModule, not registered here directly.
  imports: [AuthModule],
  controllers: [BillsController, PortalBillsController],
  providers: [ApiKeyGuard, BillsService, PortalBillsService],
  exports: [ApiKeyGuard],
})
export class BillsModule {}
