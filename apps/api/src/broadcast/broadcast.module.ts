import { Module } from '@nestjs/common';
import { BroadcastSenderService } from './broadcast-sender.service';

@Module({
  providers: [BroadcastSenderService],
  exports: [BroadcastSenderService],
})
export class BroadcastModule {}
