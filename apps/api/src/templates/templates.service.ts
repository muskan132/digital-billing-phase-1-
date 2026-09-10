import { ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { BillType, Prisma } from '@prisma/client';
import { BLOCK_MANIFEST, LayoutSchemaV2, validateLayoutSchema } from '@digital-billing/block-manifest';
import { PrismaService } from '../prisma/prisma.service';

export interface SaveTemplateBody {
  layoutSchema: {
    blocks: unknown;
    theme?: unknown;
  };
  // D-33: archiving is a deliberate action, never a side effect of a save.
  // Defaults false so every existing/future caller that doesn't pass it gets
  // today's behaviour (parent kept, just no longer head).
  archivePrevious?: boolean;
  // F-1 (D-62/D-63): optional in-place rename within the lineage. ABSENT (the
  // only shape every existing caller sends) keeps the parent's name exactly and
  // runs no allocation at all. Present: the F-1 allocator resolves the first
  // free name (`<name>`, then `<name> (1)`, `(2)`, ...) and a bounded P2002
  // retry absorbs a concurrent allocation racing for it.
  name?: string;
}

// F-1 (D-63): "retry, not count-then-insert". allocateName's probe and the
// forked-row insert are not atomic, so a concurrent save can take the name in
// between — caught as P2002 and retried with a fresh allocation. Bounded so a
// pathological/forced permanent conflict fails cleanly instead of looping.
export const MAX_NAME_ALLOCATION_RETRIES = 5;
// Safety ceiling on the suffix search itself — a merchant is never expected to
// hold anywhere near this many same-named live templates; hitting it means
// something is wrong, so it throws rather than scanning unbounded.
const MAX_NAME_SUFFIX = 999;

// S-10/D-60: mechanical dispatch only — which of the two Merchant default
// pointers a template's billType maps to. Not F-6's product surface (no new
// error codes, no new API shape): required now so that setDefault()/save()'s
// auto-repoint/archive()'s refusal check don't corrupt the wrong pointer the
// moment a TAX_INVOICE template exists (F-3).
function defaultColumnFor(billType: BillType): 'defaultReceiptTemplateId' | 'defaultTaxInvoiceTemplateId' {
  return billType === BillType.TAX_INVOICE ? 'defaultTaxInvoiceTemplateId' : 'defaultReceiptTemplateId';
}

// S-11 (D-63): matches a P2002 ONLY when the violated constraint is the partial
// unique index Template(merchantId, name) WHERE isHead = true — i.e. the
// merchant already has a live head template by this name. Deliberately narrow,
// same discipline as bills.service.ts's isInvoiceNumberConflict: never relabel
// some other unique constraint that could P2002 out of the same write. Today
// `Template` has no other unique constraint, but the guard is written to stay
// correct if one is ever added.
//
// The friendly 409 is the interim answer until F-2 folds clone() into Save As
// and F-1's allocator suffixes a taken name to `(1)`/`(2)`/`(n)` (D-63). Until
// then, a merchant who clones the same starter twice gets a named error, not a
// raw 500.
function isTemplateNameConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = err.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : typeof target === 'string' ? [target] : [];
  const joined = fields.join('|');
  return /merchantId/i.test(joined) && /name/i.test(joined);
}

const TEMPLATE_NAME_TAKEN = {
  error_code: 'TEMPLATE_NAME_TAKEN',
  message: 'A template with this name already exists for this merchant. Choose a different name.',
};

@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  // A-4: merchantId arrives as an argument, resolved by the caller's guard
  // (DemoOnlyGuard today, SessionGuard for /portal later) via MerchantContext
  // (D-46). This service reads no constant and no environment variable.

  // Library presets (merchantId: null) + the calling merchant's own templates.
  // D-33: archived rows never appear. Head-only per C-1 ("list head, non-archived
  // templates") — the builder's "my templates" list, not the full lineage.
  async list(merchantId: string) {
    return this.prisma.template.findMany({
      where: {
        OR: [{ merchantId }, { merchantId: null }],
        isHead: true,
        archivedAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  // W-2: read-only lookup of the merchant's own stored default — no decision
  // logic here, just the same field setDefault()/archive() already write/read
  // elsewhere, exposed for the dashboard's "Create invoice" entry point.
  // S-10/D-60: deliberately still the RECEIPT pointer only — the dashboard's
  // single "Create invoice" shortcut and its DTO shape are unchanged until
  // F-6 builds the real two-pointer UI.
  async getDefaultTemplateId(merchantId: string): Promise<string | null> {
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId }, select: { defaultReceiptTemplateId: true } });
    return merchant?.defaultReceiptTemplateId ?? null;
  }

  // Same merchant/library scope as list(), but not restricted to isHead — a
  // fetch-by-id may target a specific lineage entry, not just the current head.
  // Still excludes archived rows (D-33 soft-delete) and out-of-scope merchants.
  async findOne(id: string, merchantId: string) {
    const template = await this.prisma.template.findFirst({
      where: {
        id,
        OR: [{ merchantId }, { merchantId: null }],
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
  async save(id: string, body: SaveTemplateBody, merchantId: string) {
    if (typeof body?.layoutSchema !== 'object' || body.layoutSchema === null || !Array.isArray(body.layoutSchema.blocks)) {
      throw new UnprocessableEntityException({ error_code: 'MALFORMED_LAYOUT_SCHEMA', message: 'layoutSchema.blocks must be an array' });
    }
    if (body.archivePrevious !== undefined && typeof body.archivePrevious !== 'boolean') {
      throw new UnprocessableEntityException({ error_code: 'MALFORMED_REQUEST', message: 'archivePrevious must be a boolean' });
    }
    const archivePrevious = body.archivePrevious ?? false;

    // F-1: a rename must name something. Absent is the untouched path; present
    // must be a non-blank string. Trimmed so " Foo " and "Foo" are one name.
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length === 0)) {
      throw new UnprocessableEntityException({ error_code: 'MALFORMED_REQUEST', message: 'name must be a non-empty string when provided' });
    }
    const requestedName = body.name?.trim();

    // Same merchant/library read-scope as findOne, but the write scope is
    // narrower: only the merchant's OWN head templates are forkable here.
    const parent = await this.prisma.template.findFirst({
      where: {
        id,
        OR: [{ merchantId }, { merchantId: null }],
        archivedAt: null,
      },
    });
    if (!parent) {
      throw new NotFoundException();
    }
    const parentMerchantId = parent.merchantId;
    if (parentMerchantId === null) {
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

    // F-1: no `name` → one attempt, keep the parent's name, no allocation at
    // all (every existing caller lands here, unchanged). With a `name`, the
    // allocator runs inside the transaction and a P2002 from a concurrent
    // allocation is retried with a fresh allocation, bounded (D-63).
    const maxAttempts = requestedName === undefined ? 1 : MAX_NAME_ALLOCATION_RETRIES;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.prisma.$transaction(async (tx) => {
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

          // Allocated AFTER the flip, so renaming a lineage to its own current
          // name resolves to that name (the parent has just left the index's
          // scope), not `<name> (1)`.
          const name = requestedName === undefined ? parent.name : await this.allocateName(tx, parentMerchantId, requestedName);

          const forked = await tx.template.create({
            data: {
              merchantId: parentMerchantId,
              name,
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
          // S-10/D-60: dispatched to the pointer matching the parent's own
          // billType, so forking a TAX_INVOICE template can never repoint the
          // RECEIPT pointer the callback path trusts, or vice versa.
          const defaultColumn = defaultColumnFor(parent.billType);
          await tx.merchant.updateMany({
            where: { id: parentMerchantId, [defaultColumn]: parent.id },
            data: { [defaultColumn]: forked.id },
          });

          return forked;
        });
      } catch (err) {
        if (isTemplateNameConflict(err)) {
          // F-1: with a requested name, a concurrent allocation beat us to it —
          // re-allocate and retry, bounded. A no-name save (or the final retry)
          // surfaces S-11's named 409 rather than a raw P2002/500.
          if (requestedName !== undefined && attempt < maxAttempts) {
            continue;
          }
          throw new ConflictException(TEMPLATE_NAME_TAKEN);
        }
        throw err;
      }
    }

    // The loop returns on success and throws on its final attempt; this is only
    // here to satisfy the type checker.
    throw new ConflictException(TEMPLATE_NAME_TAKEN);
  }

  // F-1 (D-63): the name allocator. Returns the first name not held by one of
  // this merchant's LIVE HEAD templates — the desired name itself, then
  // `<name> (1)`, `(2)`, ... Archived rows keep isHead = true (D-65), so a name
  // reserved by an archived template counts as taken.
  //
  // Called INSIDE save()'s transaction with the `tx` client, AFTER the parent's
  // isHead has been flipped — see the call site. Not atomic with the caller's
  // insert on its own: save()'s bounded P2002 retry is what closes the window
  // between the probe here and the create (D-63: "retry, not count-then-
  // insert"). F-2 (Save As) and F-5 (restore) reuse this method.
  private async allocateName(tx: Prisma.TransactionClient, merchantId: string, desiredName: string): Promise<string> {
    for (let n = 0; n <= MAX_NAME_SUFFIX; n++) {
      const candidate = n === 0 ? desiredName : `${desiredName} (${n})`;
      const taken = await tx.template.findFirst({
        where: { merchantId, name: candidate, isHead: true },
        select: { id: true },
      });
      if (!taken) {
        return candidate;
      }
    }
    throw new ConflictException({
      error_code: 'TEMPLATE_NAME_ALLOCATION_EXHAUSTED',
      message: `Could not find a free name for "${desiredName}" within ${MAX_NAME_SUFFIX} suffixes.`,
    });
  }

  // C-3: clone-from-library — a genuine deep copy, never a reference (D-33 /
  // TEMPLATE_SYSTEM_v2 §8 rule 7). The clone gets its OWN fresh lineage
  // (parentTemplateId: null, version: 1), not a fork of the preset's — a
  // merchant template must never trace its history back into shared library
  // rows. Only presets may be cloned; a merchant's own template already has
  // its own lineage and forks via save() (C-2) instead.
  async clone(id: string, merchantId: string) {
    const preset = await this.prisma.template.findFirst({
      where: {
        id,
        OR: [{ merchantId }, { merchantId: null }],
        archivedAt: null,
      },
    });
    if (!preset) {
      throw new NotFoundException();
    }
    if (preset.merchantId !== null) {
      throw new UnprocessableEntityException({ error_code: 'CANNOT_CLONE_MERCHANT_TEMPLATE' });
    }

    try {
      return await this.prisma.template.create({
        data: {
          merchantId,
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
    } catch (err) {
      // S-11 (D-63): the merchant has already cloned this starter — a second
      // copy would be a duplicate live head name, which the partial unique
      // index now rejects. Named 409 rather than a raw P2002/500. F-2 folds
      // clone() into Save As, where F-1's allocator suffixes to `(1)` instead.
      if (isTemplateNameConflict(err)) {
        throw new ConflictException(TEMPLATE_NAME_TAKEN);
      }
      throw err;
    }
  }

  // C-3: set-default. Target must be within read-scope (C-1) and a live,
  // current head — pointing the default at an archived or superseded row
  // would make every subsequent bill resolve a template no longer shown
  // anywhere in the builder.
  async setDefault(id: string, merchantId: string) {
    const template = await this.prisma.template.findFirst({
      where: {
        id,
        OR: [{ merchantId }, { merchantId: null }],
        archivedAt: null,
      },
    });
    if (!template) {
      throw new NotFoundException();
    }
    if (!template.isHead) {
      throw new UnprocessableEntityException({ error_code: 'CANNOT_SET_NON_HEAD_AS_DEFAULT' });
    }

    // S-10/D-60: dispatched to the pointer matching this template's own
    // billType — mechanical dispatch only, not F-6's per-billType product
    // surface (no new error codes, no response shape change here).
    return this.prisma.merchant.update({
      where: { id: merchantId },
      data: { [defaultColumnFor(template.billType)]: template.id },
    });
  }

  // C-3: archive (D-33 — soft-archive only, no hard delete anywhere). Refused
  // for the current default, with the reason named in the response, per the
  // roadmap's own verify wording. Restricted to the merchant's own head rows,
  // same reasoning as save()'s CANNOT_FORK_LIBRARY_PRESET: archiving a shared
  // preset would remove it from every merchant's list, not just this one's;
  // archiving a non-head row has no visible effect since only the head ever
  // appears in list().
  async archive(id: string, merchantId: string) {
    const template = await this.prisma.template.findFirst({
      where: { id, merchantId, archivedAt: null },
    });
    if (!template) {
      throw new NotFoundException();
    }
    if (!template.isHead) {
      throw new UnprocessableEntityException({ error_code: 'CANNOT_ARCHIVE_NON_HEAD_VERSION' });
    }

    // S-10/D-60: checked against the pointer matching this template's own
    // billType — mechanical dispatch only, not F-6's product surface.
    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId } });
    if (merchant?.[defaultColumnFor(template.billType)] === id) {
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
