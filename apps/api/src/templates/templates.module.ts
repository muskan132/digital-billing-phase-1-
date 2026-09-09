import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TemplatesController } from './templates.controller';
import { PortalTemplatesController } from './portal-templates.controller';
import { TemplatesService } from './templates.service';

@Module({
  // W-2: AuthModule imported so SessionGuard (used by PortalTemplatesController)
  // can resolve its own DI dependencies — same reasoning as BillsModule (H-1).
  imports: [AuthModule],
  controllers: [TemplatesController, PortalTemplatesController],
  providers: [TemplatesService],
})
export class TemplatesModule {}
