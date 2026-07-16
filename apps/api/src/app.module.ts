import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { CallbacksModule } from './callbacks/callbacks.module';
import { LinksModule } from './links/links.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule, CallbacksModule, LinksModule],
  controllers: [HealthController],
})
export class AppModule {}
