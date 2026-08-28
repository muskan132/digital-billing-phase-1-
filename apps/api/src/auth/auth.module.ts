import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth.controller';
import { SessionService } from './session.service';
import { SessionGuard } from './session.guard';
import { CsrfGuard } from './csrf.guard';

@Module({
  controllers: [AuthController],
  providers: [
    SessionService,
    SessionGuard,
    // A-5 / D-57: global, not per-controller — a new /portal route inherits
    // CSRF enforcement automatically. CsrfGuard's own path+method check is a
    // no-op for every non-mutating/non-/portal request.
    { provide: APP_GUARD, useClass: CsrfGuard },
  ],
  exports: [SessionService, SessionGuard],
})
export class AuthModule {}
