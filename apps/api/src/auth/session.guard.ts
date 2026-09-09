// A-3: the one enforcement point every /portal route sits behind. Hashes the
// cookie, loads the session (SessionService, A-2 — not reimplemented here),
// re-checks eligibility (isEligibleUser, A-2 — the SAME function login uses,
// per D-45), and attaches MerchantContext (D-46). Role gate per D-50, read
// from @Roles(...) route metadata — method-level OR class-level (D-59).
import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SessionService } from './session.service';
import { isEligibleUser } from './eligibility';
import { parseCookies } from './cookie.util';
import { ROLES_KEY } from './roles.decorator';
import { MerchantContext } from './merchant-context';
import { UserRole } from '@prisma/client';

const SESSION_COOKIE = 'session';

interface SessionRequest {
  headers: { cookie?: string };
  merchantContext?: MerchantContext;
}

interface ClearableCookieResponse {
  clearCookie(name: string, options?: Record<string, unknown>): void;
}

@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly sessions: SessionService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<SessionRequest>();
    const response = context.switchToHttp().getResponse<ClearableCookieResponse>();

    // NestJS's default for canActivate() returning false is a 403
    // ForbiddenException — wrong for every one of these cases, which the
    // roadmap requires as 401. Thrown explicitly, never left to the default.
    const unauthorized = (): UnauthorizedException => {
      response.clearCookie(SESSION_COOKIE, { path: '/' });
      return new UnauthorizedException();
    };

    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (!token) {
      throw unauthorized();
    }

    const session = await this.sessions.findActiveSession(token);
    if (!session) {
      throw unauthorized();
    }

    // Re-checked HERE, on every request, against the just-loaded row — not
    // the eligibility snapshot from whenever the session was issued. This is
    // the literal mechanism behind "disabling mid-session kills the next
    // request" (D-45).
    if (!isEligibleUser(session.user)) {
      throw unauthorized();
    }

    request.merchantContext = {
      userId: session.user.id,
      merchantId: session.user.merchantId!, // non-null: isEligibleUser already required this
      role: session.user.role,
    };

    // D-59: method-level @Roles() overrides class-level; class-level is the
    // fallback when a route declares none of its own. A plain .get(handler)
    // never sees class-level metadata at all — that was the bug D-59 fixes.
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (requiredRoles && requiredRoles.length > 0 && !requiredRoles.includes(session.user.role)) {
      // Deliberately no clearCookie here — the session itself is still
      // valid, this user simply lacks the role for this one route. Thrown
      // explicitly (403), not left to an implicit return-false default.
      throw new ForbiddenException();
    }

    return true;
  }
}
