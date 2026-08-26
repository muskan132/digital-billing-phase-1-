// A-2: session issuance/lookup/revocation (D-43's opaque-token shape). This
// is the ONE place a raw session token is hashed or compared — A-3's
// SessionGuard calls findActiveSession() rather than reimplementing the hash.
import { createHash, randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { MerchantSession, User } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

// D-56: 24 hours, absolute, no sliding renewal.
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function hashToken(token: string): Uint8Array<ArrayBuffer> {
  const digest = createHash('sha256').update(token).digest();
  const out = new Uint8Array(new ArrayBuffer(digest.length));
  out.set(digest);
  return out;
}

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  // Returns the plaintext token exactly once — the caller must put it
  // straight into the Set-Cookie header and never log it (D-43).
  async issueSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.prisma.merchantSession.create({
      data: { userId, tokenHash: hashToken(token), expiresAt },
    });
    return { token, expiresAt };
  }

  // Null for: unknown token, revoked, or expired — every "not usable" case
  // collapses to the same null so callers can't accidentally branch on why.
  async findActiveSession(token: string): Promise<(MerchantSession & { user: User }) | null> {
    const session = await this.prisma.merchantSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt <= new Date()) {
      return null;
    }
    return session;
  }

  // Revocation is a state, never a delete (D-51). Returns false if the token
  // was already unusable (unknown/revoked/expired) — logout on a dead cookie
  // is a caller-visible 401, not a silent no-op.
  async revokeSession(token: string): Promise<boolean> {
    const session = await this.findActiveSession(token);
    if (!session) {
      return false;
    }
    await this.prisma.merchantSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    return true;
  }
}
