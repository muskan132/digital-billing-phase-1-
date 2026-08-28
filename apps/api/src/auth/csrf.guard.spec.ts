import { Controller, ExecutionContext, Get, INestApplication, Post } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { CsrfGuard } from './csrf.guard';
import { deriveCsrfToken } from './csrf.util';

const ORIGINAL_CSRF_SECRET = process.env.CSRF_SECRET;

function makeContext(input: {
  method: string;
  path: string;
  cookie?: string;
  csrfHeader?: string;
}): ExecutionContext {
  const request = {
    method: input.method,
    path: input.path,
    headers: {
      ...(input.cookie ? { cookie: input.cookie } : {}),
      ...(input.csrfHeader !== undefined ? { 'x-csrf-token': input.csrfHeader } : {}),
    },
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('CsrfGuard (unit)', () => {
  let guard: CsrfGuard;

  beforeAll(() => {
    process.env.CSRF_SECRET = 'test-secret';
  });

  afterAll(() => {
    process.env.CSRF_SECRET = ORIGINAL_CSRF_SECRET;
  });

  beforeEach(() => {
    guard = new CsrfGuard();
  });

  it('is a no-op for GET requests under /portal, token or not', () => {
    expect(guard.canActivate(makeContext({ method: 'GET', path: '/portal/bills' }))).toBe(true);
  });

  it('is a no-op for non-/portal paths, even mutating methods with no token', () => {
    expect(guard.canActivate(makeContext({ method: 'POST', path: '/v1/bills' }))).toBe(true);
    expect(guard.canActivate(makeContext({ method: 'POST', path: '/demo/whatever' }))).toBe(true);
  });

  it('rejects a mutating /portal request with no session cookie at all', () => {
    expect(() => guard.canActivate(makeContext({ method: 'POST', path: '/portal/templates/x/save' }))).toThrow(
      expect.objectContaining({ response: expect.objectContaining({ error_code: 'CSRF_TOKEN_INVALID' }) }),
    );
  });

  it('rejects a mutating /portal request with a session cookie but no X-CSRF-Token header', () => {
    expect(() =>
      guard.canActivate(makeContext({ method: 'POST', path: '/portal/templates/x/save', cookie: 'session=abc123' })),
    ).toThrow(expect.objectContaining({ response: expect.objectContaining({ error_code: 'CSRF_TOKEN_INVALID' }) }));
  });

  it('rejects a mismatched token — same error as missing (D-57: not distinguishable)', () => {
    expect(() =>
      guard.canActivate(
        makeContext({ method: 'POST', path: '/portal/templates/x/save', cookie: 'session=abc123', csrfHeader: 'wrong-token' }),
      ),
    ).toThrow(expect.objectContaining({ response: expect.objectContaining({ error_code: 'CSRF_TOKEN_INVALID' }) }));
  });

  it('rejects a token correctly derived from a DIFFERENT session token', () => {
    const tokenForOtherSession = deriveCsrfToken('some-other-session-token');
    expect(() =>
      guard.canActivate(
        makeContext({
          method: 'POST',
          path: '/portal/templates/x/save',
          cookie: 'session=abc123',
          csrfHeader: tokenForOtherSession,
        }),
      ),
    ).toThrow(expect.objectContaining({ response: expect.objectContaining({ error_code: 'CSRF_TOKEN_INVALID' }) }));
  });

  it('accepts a correctly-derived token for the actual session', () => {
    const validToken = deriveCsrfToken('abc123');
    expect(
      guard.canActivate(
        makeContext({ method: 'POST', path: '/portal/templates/x/save', cookie: 'session=abc123', csrfHeader: validToken }),
      ),
    ).toBe(true);
  });
});

// Structural test: proves the guard protects a route NOBODY decorated, because
// it is registered as a global APP_GUARD rather than opt-in per controller.
// This is the actual proof "a future /portal route cannot ship unprotected" —
// not an assertion about the guard's internal logic, which the unit tests above
// already cover.
@Controller('portal')
class ProbeController {
  @Post('__test_probe')
  probe() {
    return { ok: true };
  }

  @Get('__test_probe_get')
  probeGet() {
    return { ok: true };
  }
}

describe('CsrfGuard (structural — global APP_GUARD, real HTTP)', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.CSRF_SECRET = 'test-secret';

    const moduleRef = await Test.createTestingModule({
      controllers: [ProbeController],
      providers: [{ provide: APP_GUARD, useClass: CsrfGuard }],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
    await app.listen(0);

    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await app.close();
    process.env.CSRF_SECRET = ORIGINAL_CSRF_SECRET;
  });

  it('rejects an undecorated POST /portal route with no CSRF token — 403, no opt-in required', async () => {
    const res = await fetch(`${baseUrl}/portal/__test_probe`, { method: 'POST' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error_code?: string; message?: { error_code?: string } };
    expect(body.error_code ?? body.message?.error_code).toBeTruthy();
  });

  it('allows an undecorated GET /portal route through with no token at all', async () => {
    const res = await fetch(`${baseUrl}/portal/__test_probe_get`, { method: 'GET' });
    expect(res.status).toBe(200);
  });

  it('allows the POST through once a correctly-derived token and session cookie are both present', async () => {
    const sessionToken = 'a-real-looking-session-token';
    const csrfToken = deriveCsrfToken(sessionToken);
    const res = await fetch(`${baseUrl}/portal/__test_probe`, {
      method: 'POST',
      headers: {
        cookie: `session=${sessionToken}`,
        'x-csrf-token': csrfToken,
      },
    });
    expect(res.status).toBe(201);
  });
});
