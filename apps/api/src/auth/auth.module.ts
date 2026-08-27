import { Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { SessionService } from './session.service';
import { SessionGuard } from './session.guard';

@Module({
  controllers: [AuthController],
  providers: [SessionService, SessionGuard],
  exports: [SessionService, SessionGuard],
})
export class AuthModule {}
