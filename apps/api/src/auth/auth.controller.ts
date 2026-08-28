// A-2: /auth/login, /auth/callback, /portal/logout. Subject->User resolution,
// eligibility (D-45's rule, shared with A-3 via isEligibleUser), session
// issuance, cookie set/clear. Does NOT build SessionGuard/MerchantContext —
// that is A-3; this only needs enough session-lookup logic for its own three
// routes (logout's replay-401 case) to behave correctly.
import { Controller, Get, Post, Query, Req, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SessionService } from './session.service';
import { SessionGuard } from './session.guard';
import { CurrentMerchantContext, MerchantContext } from './merchant-context';
import { isEligibleUser } from './eligibility';
import { parseCookies } from './cookie.util';
import { deriveCsrfToken } from './csrf.util';
import { isSafeReturnTo } from './return-to.util';
import { OidcIdentityProviderAdapter } from './oidc-identity-provider.adapter';

const SESSION_COOKIE = 'session';
const FLOW_COOKIE = 'oidc_flow';
const FLOW_COOKIE_MAX_AGE_MS = 10 * 60 * 1000; // just long enough for a real login round trip
const SESSION_COOKIE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // D-56

// D-44: HttpOnly/SameSite=Lax/Path=/, no Domain, Secure everywhere except
// local HTTP. Full CSRF token enforcement on state-changing routes is A-5 —
// this only gets the cookie's own attributes right.
const SECURE_COOKIES = process.env.NODE_ENV === 'production';

interface CookieOptions {
  httpOnly?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  path?: string;
  secure?: boolean;
  maxAge?: number;
}

interface AuthResponse {
  cookie(name: string, value: string, options?: CookieOptions): void;
  clearCookie(name: string, options?: CookieOptions): void;
  redirect(url: string): void;
  status(code: number): { send(body?: unknown): void };
}

interface AuthRequest {
  headers: { cookie?: string };
  protocol: string;
  originalUrl: string;
  get(name: string): string | undefined;
}

interface FlowCookiePayload {
  state: string;
  nonce: string;
  codeVerifier: string;
  // W-1: the /portal path that started the login, so callback can send the
  // user back there instead of always to /portal root. Validated (isSafeReturnTo)
  // both when written here and again when read in callback().
  returnTo?: string;
}

@Controller()
export class AuthController {
  private readonly identityProvider = new OidcIdentityProviderAdapter({
    issuer: process.env.OIDC_ISSUER ?? 'http://localhost:9000',
    clientId: process.env.OIDC_CLIENT_ID ?? 'digital-billing-portal',
    redirectUri: process.env.OIDC_REDIRECT_URI ?? 'http://localhost:4000/auth/callback',
    allowInsecureRequests: process.env.NODE_ENV !== 'production',
  });

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
  ) {}

  @Get('auth/login')
  async login(@Query('returnTo') returnTo: string | undefined, @Res() res: AuthResponse) {
    const authReq = await this.identityProvider.createAuthorizationRequest();

    const payload: FlowCookiePayload = {
      state: authReq.state,
      nonce: authReq.nonce,
      codeVerifier: authReq.codeVerifier,
      ...(isSafeReturnTo(returnTo) ? { returnTo } : {}),
    };
    res.cookie(FLOW_COOKIE, JSON.stringify(payload), {
      httpOnly: true,
      sameSite: 'lax',
      path: '/auth',
      secure: SECURE_COOKIES,
      maxAge: FLOW_COOKIE_MAX_AGE_MS,
    });

    res.redirect(authReq.url);
  }

  @Get('auth/callback')
  async callback(@Req() req: AuthRequest, @Res() res: AuthResponse) {
    const clearFlowCookie = () => res.clearCookie(FLOW_COOKIE, { path: '/auth' });

    const cookies = parseCookies(req.headers.cookie);
    const rawFlow = cookies[FLOW_COOKIE];
    if (!rawFlow) {
      clearFlowCookie();
      res.status(400).send({ error_code: 'MISSING_OIDC_FLOW_COOKIE' });
      return;
    }

    let flow: FlowCookiePayload;
    try {
      flow = JSON.parse(rawFlow) as FlowCookiePayload;
    } catch {
      clearFlowCookie();
      res.status(400).send({ error_code: 'MALFORMED_OIDC_FLOW_COOKIE' });
      return;
    }

    const callbackUrl = new URL(req.originalUrl, `${req.protocol}://${req.get('host')}`);

    let identity;
    try {
      identity = await this.identityProvider.completeAuthorizationCodeFlow({
        callbackUrl,
        expectedState: flow.state,
        expectedNonce: flow.nonce,
        codeVerifier: flow.codeVerifier,
      });
    } catch {
      clearFlowCookie();
      res.status(400).send({ error_code: 'OIDC_CALLBACK_REJECTED' });
      return;
    }
    clearFlowCookie();

    const user = await this.prisma.user.findUnique({ where: { subject: identity.subject } });
    if (!isEligibleUser(user)) {
      // D-41/D-45: unknown subject, INTERNAL user, no merchant, or disabled —
      // all collapse to the same 403, zero MerchantSession rows written.
      res.status(403).send({ error_code: 'NOT_ELIGIBLE_FOR_PORTAL' });
      return;
    }

    const session = await this.sessions.issueSession(user!.id);
    await this.prisma.user.update({ where: { id: user!.id }, data: { lastLoginAt: new Date() } });

    res.cookie(SESSION_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: SECURE_COOKIES,
      maxAge: SESSION_COOKIE_MAX_AGE_MS,
    });

    // W-1: back to the path that started the login, re-validated here since
    // the flow cookie round-tripped through the browser — never trust it
    // blindly even though it's HttpOnly. Falls back to /portal root.
    const target = isSafeReturnTo(flow.returnTo) ? flow.returnTo : '/portal';
    res.redirect(`${process.env.PUBLIC_BILL_BASE_URL ?? 'http://localhost:3000'}${target}`);
  }

  // A-5 / D-57: the ONLY way a client ever obtains the CSRF token — never a
  // cookie. Requires an already-valid session (SessionGuard); called once
  // after login, cached client-side for the session's lifetime.
  @Get('portal/csrf-token')
  @UseGuards(SessionGuard)
  async csrfToken(@Req() req: AuthRequest) {
    const cookies = parseCookies(req.headers.cookie);
    const sessionToken = cookies[SESSION_COOKIE];
    if (!sessionToken) {
      // Unreachable in practice — SessionGuard already required a valid
      // session cookie to reach this handler at all. Fails closed anyway,
      // never silently derives a token from nothing.
      throw new UnauthorizedException();
    }
    return { token: deriveCsrfToken(sessionToken) };
  }

  // W-1: the portal shell's own nav data — merchant name and role, sourced
  // from the session's MerchantContext, never a query param or client-side
  // state. No business data (bills/templates) — that's H-1/W-2/W-3.
  @Get('portal/me')
  @UseGuards(SessionGuard)
  async me(@CurrentMerchantContext() ctx: MerchantContext) {
    const merchant = await this.prisma.merchant.findUniqueOrThrow({
      where: { id: ctx.merchantId },
      select: { name: true },
    });
    return { merchantName: merchant.name, role: ctx.role };
  }

  @Post('portal/logout')
  async logout(@Req() req: AuthRequest, @Res() res: AuthResponse) {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];

    const revoked = token ? await this.sessions.revokeSession(token) : false;
    res.clearCookie(SESSION_COOKIE, { path: '/' });

    if (!revoked) {
      res.status(401).send({ error_code: 'NO_ACTIVE_SESSION' });
      return;
    }
    res.status(200).send({ ok: true });
  }
}
