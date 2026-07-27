import { CanActivate, ExecutionContext, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const KEY_PREFIX_LENGTH = 8;

// D-19: ApiKeyGuard, structurally the same seam as SecureHashGuard. The credential
// lives in MerchantApiKey (keyPrefix for lookup, keyHash = SHA-256 of the full key),
// never in a Merchant column — a compromised API key must not imply anything about
// the PG HMAC secret, and vice versa.
@Injectable()
export class ApiKeyGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyGuard.name);

  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();

    const authHeader = request.headers?.authorization;
    const match = typeof authHeader === 'string' ? /^Bearer (.+)$/.exec(authHeader) : null;
    if (!match) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }
    const providedKey = match[1];

    const keyPrefix = providedKey.slice(0, KEY_PREFIX_LENGTH);
    const apiKey = await this.prisma.merchantApiKey.findUnique({ where: { keyPrefix } });
    if (!apiKey) {
      this.logger.warn(`API key rejected — unknown keyPrefix=${keyPrefix}`);
      throw new UnauthorizedException('Invalid API key');
    }

    const providedHash = createHash('sha256').update(providedKey).digest();
    const isMatch =
      providedHash.length === apiKey.keyHash.length && timingSafeEqual(providedHash, apiKey.keyHash);
    if (!isMatch) {
      this.logger.warn(`API key rejected — hash mismatch keyPrefix=${keyPrefix}`);
      throw new UnauthorizedException('Invalid API key');
    }

    if (apiKey.status !== 'ACTIVE') {
      this.logger.warn(`API key rejected — status=${apiKey.status} keyPrefix=${keyPrefix}`);
      throw new UnauthorizedException('Invalid API key');
    }

    // TODO(I-1, BR-15): body-merchant mismatch check deferred here. I-1 owns the
    // POST /v1/bills DTO shape and must decide whether/what merchant-identifying field
    // the body carries (if any) and how it's compared to the merchantId resolved below
    // — not something this guard can correctly assume ahead of that decision.
    request.merchantId = apiKey.merchantId;

    this.logger.log(`API key accepted — keyPrefix=${keyPrefix}`);
    return true;
  }
}
