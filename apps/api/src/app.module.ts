import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { CallbacksModule } from './callbacks/callbacks.module';
import { LinksModule } from './links/links.module';
import { PrismaModule } from './prisma/prisma.module';
import { BroadcastModule } from './broadcast/broadcast.module';

@Module({
  imports: [PrismaModule, CallbacksModule, LinksModule, BroadcastModule],
  controllers: [HealthController],
})
export class AppModule {}
