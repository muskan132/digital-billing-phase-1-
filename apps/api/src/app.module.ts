import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthController } from './health.controller';
import { CallbacksModule } from './callbacks/callbacks.module';
import { LinksModule } from './links/links.module';
import { PrismaModule } from './prisma/prisma.module';
import { BroadcastModule } from './broadcast/broadcast.module';
import { BillsModule } from './bills/bills.module';
import { DemoModule } from './demo/demo.module';
import { TemplatesModule } from './templates/templates.module';
import { FixturesModule } from './fixtures/fixtures.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    PrismaModule,
    CallbacksModule,
    LinksModule,
    BroadcastModule,
    BillsModule,
    DemoModule,
    TemplatesModule,
    FixturesModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
