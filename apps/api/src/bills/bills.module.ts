import { Module } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { BillsController } from './bills.controller';
import { BillsService } from './bills.service';

@Module({
  controllers: [BillsController],
  providers: [ApiKeyGuard, BillsService],
  exports: [ApiKeyGuard],
})
export class BillsModule {}
