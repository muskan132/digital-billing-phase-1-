import { Module } from '@nestjs/common';
import { FixturesController } from './fixtures.controller';

@Module({
  controllers: [FixturesController],
})
export class FixturesModule {}
