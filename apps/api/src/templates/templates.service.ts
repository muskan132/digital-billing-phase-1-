import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BLOCK_MANIFEST, LayoutSchemaV2, validateLayoutSchema } from '@digital-billing/block-manifest';
import { PrismaService } from '../prisma/prisma.service';

// C-1: the seeded merchant's fixed id (matches apps/api/prisma/seed.ts's
// MERCHANT_ID and demo.service.ts's hardcoded-seed-id pattern). No auth guard
// resolves this from a request here — the demo builder has no bearer token —
// so it's a constant, same as the rest of the demo surface.
const SEED_MERCHANT_ID = 'seed-merchant-demo';

export interface SaveTemplateBody {
  layoutSchema: {
    blocks: unknown;
    theme?: unknown;
  };
  // D-33: archiving is a deliberate action, never a side effect of a save.
  // Defaults false so every existing/future caller that doesn't pass it gets
  // today's behaviour (parent kept, just no longer head).
  archivePrevious?: boolean;
}

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

  // C-2: fork-on-write save (D-32). Never mutates the parent's layoutSchema —
  // every save creates a NEW Template row and flips the parent's isHead off.
  // Validate-before-persist (T-6): an invalid document throws before the
  // transaction ever opens, so a 422 leaves zero writes, same discipline as
  // G-1/M-3.
  async save(id: string, body: SaveTemplateBody) {
    if (typeof body?.layoutSchema !== 'object' || body.layoutSchema === null || !Array.isArray(body.layoutSchema.blocks)) {
      throw new UnprocessableEntityException({ error_code: 'MALFORMED_LAYOUT_SCHEMA', message: 'layoutSchema.blocks must be an array' });
    }
    if (body.archivePrevious !== undefined && typeof body.archivePrevious !== 'boolean') {
      throw new UnprocessableEntityException({ error_code: 'MALFORMED_REQUEST', message: 'archivePrevious must be a boolean' });
    }
    const archivePrevious = body.archivePrevious ?? false;

    // Same merchant/library read-scope as findOne, but the write scope is
    // narrower: only the merchant's OWN head templates are forkable here.
    const parent = await this.prisma.template.findFirst({
      where: {
        id,
        OR: [{ merchantId: SEED_MERCHANT_ID }, { merchantId: null }],
        archivedAt: null,
      },
    });
    if (!parent) {
      throw new NotFoundException();
    }
    const merchantId = parent.merchantId;
    if (merchantId === null) {
      // D-33 / TEMPLATE_SYSTEM_v2 §8 rule 7: presets are immutable to merchants —
      // forking one directly (rather than through a deep-copy clone, C-3) would
      // let an edit history attach to a row every merchant shares.
      throw new UnprocessableEntityException({ error_code: 'CANNOT_FORK_LIBRARY_PRESET' });
    }
    if (!parent.isHead) {
      // Forking a non-head row would produce two isHead:true rows in one
      // lineage — there is already a different current head for this template.
      throw new UnprocessableEntityException({ error_code: 'CANNOT_FORK_NON_HEAD_VERSION' });
    }

    // Reconstructed server-side, never trusting the client's schemaVersion/
    // skeleton — only `blocks`/`theme` content is client-controlled.
    const doc: LayoutSchemaV2 = {
      schemaVersion: 2,
      skeleton: parent.skeleton,
      blocks: body.layoutSchema.blocks as LayoutSchemaV2['blocks'],
      ...(body.layoutSchema.theme ? { theme: body.layoutSchema.theme as LayoutSchemaV2['theme'] } : {}),
    };

    const issues = validateLayoutSchema(doc, BLOCK_MANIFEST);
    if (issues.length > 0) {
      throw new UnprocessableEntityException({ error_code: 'INVALID_LAYOUT_SCHEMA', issues });
    }

    return this.prisma.$transaction(async (tx) => {
      // Concurrency guard: if isHead flipped since the read above (a
      // concurrent save/archive), this matches zero rows — abort rather than
      // create a second head on top of one already forked.
      const flipped = await tx.template.updateMany({
        where: { id: parent.id, isHead: true },
        data: { isHead: false, ...(archivePrevious ? { archivedAt: new Date() } : {}) },
      });
      if (flipped.count !== 1) {
        throw new ConflictException({ error_code: 'TEMPLATE_HEAD_CHANGED' });
      }

      const forked = await tx.template.create({
        data: {
          merchantId,
          name: parent.name,
          billType: parent.billType,
          skeleton: parent.skeleton,
          layoutSchema: doc as unknown as Prisma.InputJsonValue,
          version: parent.version + 1,
          parentTemplateId: parent.id,
          isHead: true,
        },
      });

      // Unconditional match-or-no-op — repoints the default only if it
      // actually pointed at the parent, atomically with the flip/archive above.
      await tx.merchant.updateMany({
        where: { id: merchantId, defaultTemplateId: parent.id },
        data: { defaultTemplateId: forked.id },
      });

      return forked;
    });
  }

  // C-3: clone-from-library — a genuine deep copy, never a reference (D-33 /
  // TEMPLATE_SYSTEM_v2 §8 rule 7). The clone gets its OWN fresh lineage
  // (parentTemplateId: null, version: 1), not a fork of the preset's — a
  // merchant template must never trace its history back into shared library
  // rows. Only presets may be cloned; a merchant's own template already has
  // its own lineage and forks via save() (C-2) instead.
  async clone(id: string) {
    const preset = await this.prisma.template.findFirst({
      where: {
        id,
        OR: [{ merchantId: SEED_MERCHANT_ID }, { merchantId: null }],
        archivedAt: null,
      },
    });
    if (!preset) {
      throw new NotFoundException();
    }
    if (preset.merchantId !== null) {
      throw new UnprocessableEntityException({ error_code: 'CANNOT_CLONE_MERCHANT_TEMPLATE' });
    }

    return this.prisma.template.create({
      data: {
        merchantId: SEED_MERCHANT_ID,
        name: preset.name,
        billType: preset.billType,
        skeleton: preset.skeleton,
        // A fresh Prisma-fetched JSON value — copying it into a new row's
        // column is already an independent Postgres jsonb value, not a
        // reference of any kind. No further serialization needed for the
        // "deep copy" guarantee.
        layoutSchema: preset.layoutSchema as Prisma.InputJsonValue,
        version: 1,
        parentTemplateId: null,
        isHead: true,
      },
    });
  }

  // C-3: set-default. Target must be within read-scope (C-1) and a live,
  // current head — pointing the default at an archived or superseded row
  // would make every subsequent bill resolve a template no longer shown
  // anywhere in the builder.
  async setDefault(id: string) {
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
    if (!template.isHead) {
      throw new UnprocessableEntityException({ error_code: 'CANNOT_SET_NON_HEAD_AS_DEFAULT' });
    }

    return this.prisma.merchant.update({
      where: { id: SEED_MERCHANT_ID },
      data: { defaultTemplateId: template.id },
    });
  }

  // C-3: archive (D-33 — soft-archive only, no hard delete anywhere). Refused
  // for the current default, with the reason named in the response, per the
  // roadmap's own verify wording. Restricted to the merchant's own head rows,
  // same reasoning as save()'s CANNOT_FORK_LIBRARY_PRESET: archiving a shared
  // preset would remove it from every merchant's list, not just this one's;
  // archiving a non-head row has no visible effect since only the head ever
  // appears in list().
  async archive(id: string) {
    const template = await this.prisma.template.findFirst({
      where: { id, merchantId: SEED_MERCHANT_ID, archivedAt: null },
    });
    if (!template) {
      throw new NotFoundException();
    }
    if (!template.isHead) {
      throw new UnprocessableEntityException({ error_code: 'CANNOT_ARCHIVE_NON_HEAD_VERSION' });
    }

    const merchant = await this.prisma.merchant.findUnique({ where: { id: SEED_MERCHANT_ID } });
    if (merchant?.defaultTemplateId === id) {
      throw new UnprocessableEntityException({
        error_code: 'CANNOT_ARCHIVE_DEFAULT_TEMPLATE',
        message: 'This is the merchant\'s current default template — set a different default before archiving it.',
      });
    }

    return this.prisma.template.update({
      where: { id },
      data: { archivedAt: new Date() },
    });
  }
}
