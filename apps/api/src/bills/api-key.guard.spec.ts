import { createHash } from 'crypto';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { PrismaService } from '../prisma/prisma.service';

const VALID_KEY = 'a'.repeat(64);
const VALID_KEY_PREFIX = VALID_KEY.slice(0, 8);
const VALID_KEY_HASH = createHash('sha256').update(VALID_KEY).digest();

function makeContext(headers: Record<string, unknown>): { context: ExecutionContext; request: Record<string, unknown> } {
  const request: Record<string, unknown> = { headers };
  const context = {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  return { context, request };
}

describe('ApiKeyGuard', () => {
  let findUnique: jest.Mock;
  let guard: ApiKeyGuard;

  beforeEach(() => {
    findUnique = jest.fn();
    const prisma = { merchantApiKey: { findUnique } } as unknown as PrismaService;
    guard = new ApiKeyGuard(prisma);
  });

  it('accepts a valid ACTIVE key and attaches merchantId to the request', async () => {
    findUnique.mockResolvedValue({
      merchantId: 'merchant_1',
      keyPrefix: VALID_KEY_PREFIX,
      keyHash: VALID_KEY_HASH,
      status: 'ACTIVE',
    });
    const { context, request } = makeContext({ authorization: `Bearer ${VALID_KEY}` });

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.merchantId).toBe('merchant_1');
    expect(findUnique).toHaveBeenCalledWith({ where: { keyPrefix: VALID_KEY_PREFIX } });
  });

  it('rejects an absent Authorization header', async () => {
    const { context } = makeContext({});
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects a malformed Authorization header (not "Bearer <key>")', async () => {
    const { context } = makeContext({ authorization: 'Basic abc123' });
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('rejects an unknown key (no matching keyPrefix)', async () => {
    findUnique.mockResolvedValue(null);
    const { context } = makeContext({ authorization: `Bearer ${VALID_KEY}` });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a key whose hash does not match the stored keyHash', async () => {
    findUnique.mockResolvedValue({
      merchantId: 'merchant_1',
      keyPrefix: VALID_KEY_PREFIX,
      keyHash: createHash('sha256').update('b'.repeat(64)).digest(), // different key's hash
      status: 'ACTIVE',
    });
    const { context } = makeContext({ authorization: `Bearer ${VALID_KEY}` });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects a REVOKED key', async () => {
    findUnique.mockResolvedValue({
      merchantId: 'merchant_1',
      keyPrefix: VALID_KEY_PREFIX,
      keyHash: VALID_KEY_HASH,
      status: 'REVOKED',
    });
    const { context } = makeContext({ authorization: `Bearer ${VALID_KEY}` });

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('never logs the raw key — only the keyPrefix', async () => {
    findUnique.mockResolvedValue({
      merchantId: 'merchant_1',
      keyPrefix: VALID_KEY_PREFIX,
      keyHash: VALID_KEY_HASH,
      status: 'ACTIVE',
    });
    const logSpy = jest.spyOn((guard as unknown as { logger: { log: jest.Mock } }).logger, 'log');
    const { context } = makeContext({ authorization: `Bearer ${VALID_KEY}` });

    await guard.canActivate(context);

    const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).toContain(VALID_KEY_PREFIX);
    expect(logged).not.toContain(VALID_KEY);
  });
});
