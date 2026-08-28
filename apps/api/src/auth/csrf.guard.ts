// A-5 / D-57: global CSRF enforcement. Registered as an APP_GUARD (see
// auth.module.ts) so a new /portal route inherits protection with no
// per-controller decorator to remember — the guard's own path+method check
// is what makes "cannot ship unprotected" structural, not a checklist item.
import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { parseCookies } from './cookie.util';
import { isValidCsrfToken } from './csrf.util';

const SESSION_COOKIE = 'session';
const CSRF_HEADER = 'x-csrf-token';
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

interface CsrfRequest {
  method: string;
  path: string;
  headers: { cookie?: string; [key: string]: string | string[] | undefined };
}

@Injectable()
export class CsrfGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<CsrfRequest>();

    // Structural scope: only /portal, and only mutating methods. Every other
    // request (GETs, /v1/*, /demo/*) is a no-op here — a different trust
    // model entirely (D-19/D-46), never touched by this guard.
    if (!request.path.startsWith('/portal') || !MUTATING_METHODS.has(request.method)) {
      return true;
    }

    const cookies = parseCookies(request.headers.cookie);
    const sessionToken = cookies[SESSION_COOKIE];
    const providedToken = request.headers[CSRF_HEADER];

    // No session cookie at all: nothing to derive against. This is not a
    // CSRF-specific concern (SessionGuard, wherever applied, owns "is there
    // a session"), so fail the same generic way as any other CSRF failure.
    if (!sessionToken || Array.isArray(providedToken) || !isValidCsrfToken(sessionToken, providedToken)) {
      // Missing and mismatched collapse to the SAME error (D-57) — the
      // response must not let a caller distinguish "no token sent" from
      // "wrong guess".
      throw new ForbiddenException({ error_code: 'CSRF_TOKEN_INVALID' });
    }

    return true;
  }
}
