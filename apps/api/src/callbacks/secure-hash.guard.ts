import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { computeSecureHash } from './secure-hash.util';

@Injectable()
export class SecureHashGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const body = request.body as Record<string, unknown>;

    const secureHash = body?.secureHash;
    if (!secureHash || typeof secureHash !== 'string') {
      throw new UnauthorizedException('Missing secureHash');
    }

    const merchantId = body?.merchantId;
    if (!merchantId || typeof merchantId !== 'string') {
      throw new UnauthorizedException('Missing merchantId');
    }

    const merchant = await this.prisma.merchant.findUnique({
      where: { jiopayMid: merchantId },
      select: { secretKeyEnc: true },
    });
    if (!merchant) {
      throw new UnauthorizedException('Unknown merchantId');
    }

    const expected = computeSecureHash(body, merchant.secretKeyEnc);
    if (expected !== secureHash.toLowerCase()) {
      throw new UnauthorizedException('Invalid secureHash');
    }

    return true;
  }
}
