import { Module } from '@nestjs/common';
import { BroadcastSenderService } from './broadcast-sender.service';
import { BroadcastDrainerService } from './broadcast-drainer.service';

@Module({
  providers: [BroadcastSenderService, BroadcastDrainerService],
  exports: [BroadcastSenderService],
})
export class BroadcastModule {}
