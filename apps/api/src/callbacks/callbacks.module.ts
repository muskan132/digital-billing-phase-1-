import { Module } from '@nestjs/common';
import { CallbacksController } from './callbacks.controller';

@Module({
  controllers: [CallbacksController],
})
export class CallbacksModule {}
