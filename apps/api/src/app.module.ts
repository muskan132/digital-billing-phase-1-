import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { CallbacksModule } from './callbacks/callbacks.module';

@Module({
  imports: [CallbacksModule],
  controllers: [HealthController],
})
export class AppModule {}
