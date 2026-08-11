import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// C-1: the seeded merchant's fixed id (matches apps/api/prisma/seed.ts's
// MERCHANT_ID and demo.service.ts's hardcoded-seed-id pattern). No auth guard
// resolves this from a request here — the demo builder has no bearer token —
// so it's a constant, same as the rest of the demo surface.
const SEED_MERCHANT_ID = 'seed-merchant-demo';

@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  // Library presets (merchantId: null) + the seeded merchant's own templates.
  // D-33: archived rows never appear. Head-only per C-1 ("list head, non-archived
  // templates") — the builder's "my templates" list, not the full lineage.
  async list() {
    return this.prisma.template.findMany({
      where: {
        OR: [{ merchantId: SEED_MERCHANT_ID }, { merchantId: null }],
        isHead: true,
        archivedAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  // Same merchant/library scope as list(), but not restricted to isHead — a
  // fetch-by-id may target a specific lineage entry, not just the current head.
  // Still excludes archived rows (D-33 soft-delete) and out-of-scope merchants.
  async findOne(id: string) {
    const template = await this.prisma.template.findFirst({
      where: {
        id,
        OR: [{ merchantId: SEED_MERCHANT_ID }, { merchantId: null }],
        archivedAt: null,
      },
    });
    if (!template) {
      throw new NotFoundException();
    }
    return template;
  }
}
