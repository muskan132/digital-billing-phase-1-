// W-3: real-Postgres integration coverage for the two guarantees a mocked
// PrismaService cannot prove — fork-on-write against a REAL, non-seeded
// tenant (exactly one new row, correct merchantId, parent isHead flipped,
// defaultTemplateId repointed, all in one transaction — D-32), and
// cross-merchant 404 across every id-taking builder route (D-47), not just
// the read ones H-1/H-3 already covered. defaultTemplateId is now split
// (S-10/D-60) — this test's template is billType RECEIPT throughout, so it
// exercises defaultReceiptTemplateId. Mirrors the mocked/integration
// split H-1 established — portal-templates.controller.spec.ts (mocked +
// real-HTTP role-gate structural test) covers scoping/DTO/role wiring;
// this file is real Postgres only.
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TemplatesService } from './templates.service';

const prisma = new PrismaClient();
const service = new TemplatesService(prisma as unknown as PrismaService);

let counter = 0;
function uniqueId(prefix: string): string {
  counter += 1;
  return `w3-itest-${prefix}-${Date.now()}-${counter}`;
}

interface ScratchMerchant {
  merchantId: string;
}

async function createScratchMerchant(): Promise<ScratchMerchant> {
  const merchantId = uniqueId('merchant');
  await prisma.merchant.create({
    data: { id: merchantId, jiopayMid: uniqueId('mid'), name: `W-3 itest ${merchantId}`, secretKeyEnc: Buffer.from('x') },
  });
  return { merchantId };
}

async function createOwnTemplate(merchant: ScratchMerchant, overrides: { isHead?: boolean } = {}) {
  const templateId = uniqueId('template');
  return prisma.template.create({
    data: {
      id: templateId,
      merchantId: merchant.merchantId,
      name: `W-3 itest template ${templateId}`,
      billType: 'RECEIPT',
      layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] },
      isHead: overrides.isHead ?? true,
    },
  });
}

async function cleanupMerchant(merchant: ScratchMerchant): Promise<void> {
  await prisma.template.deleteMany({ where: { merchantId: merchant.merchantId } });
  await prisma.merchant.deleteMany({ where: { id: merchant.merchantId } });
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('TemplatesService.save — fork-on-write against a REAL, non-seeded tenant (real DB, W-3 / D-32)', () => {
  let merchant: ScratchMerchant;

  beforeAll(async () => {
    merchant = await createScratchMerchant();
  });

  afterAll(async () => {
    await cleanupMerchant(merchant);
  });

  it('forking the merchant\'s own head template creates exactly one new row, merchantId = the SESSION merchant (not the seed), parent flipped, default repointed', async () => {
    const parent = await createOwnTemplate(merchant);
    await prisma.merchant.update({ where: { id: merchant.merchantId }, data: { defaultReceiptTemplateId: parent.id } });

    const beforeCount = await prisma.template.count({ where: { merchantId: merchant.merchantId } });

    const forked = await service.save(
      parent.id,
      {
        layoutSchema: {
          blocks: [
            { id: 'blk_1', type: 'HEADER', order: 1, props: {}, visible: true, width: 'full' },
            { id: 'blk_2', type: 'ITEMS', order: 2, props: {}, visible: true, width: 'full' },
          ],
        },
      },
      merchant.merchantId,
    );

    const afterCount = await prisma.template.count({ where: { merchantId: merchant.merchantId } });
    expect(afterCount).toBe(beforeCount + 1);
    expect(forked.merchantId).toBe(merchant.merchantId);
    expect(forked.merchantId).not.toBe('seed-merchant-demo');
    expect(forked.parentTemplateId).toBe(parent.id);
    expect(forked.isHead).toBe(true);

    const parentRow = await prisma.template.findUniqueOrThrow({ where: { id: parent.id } });
    expect(parentRow.isHead).toBe(false);

    const merchantRow = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.merchantId } });
    expect(merchantRow.defaultReceiptTemplateId).toBe(forked.id);
  });
});

describe('Every builder route: another merchant\'s real templateId 404s exactly like a nonexistent one (real DB, W-3 / D-47)', () => {
  let merchantA: ScratchMerchant;
  let merchantB: ScratchMerchant;
  let merchantBTemplateId: string;

  beforeAll(async () => {
    merchantA = await createScratchMerchant();
    merchantB = await createScratchMerchant();
    const template = await createOwnTemplate(merchantB);
    merchantBTemplateId = template.id;
  });

  afterAll(async () => {
    await cleanupMerchant(merchantA);
    await cleanupMerchant(merchantB);
  });

  it('findOne', async () => {
    await expect(service.findOne(merchantBTemplateId, merchantA.merchantId)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.findOne('totally-nonexistent-id', merchantA.merchantId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('save', async () => {
    await expect(
      service.save(merchantBTemplateId, { layoutSchema: { blocks: [] } }, merchantA.merchantId),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('clone', async () => {
    await expect(service.clone(merchantBTemplateId, merchantA.merchantId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('setDefault', async () => {
    await expect(service.setDefault(merchantBTemplateId, merchantA.merchantId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('archive', async () => {
    await expect(service.archive(merchantBTemplateId, merchantA.merchantId)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('the bill genuinely exists for its OWN merchant (B) — proves the 404s above came from scoping, not a fake id', async () => {
    const asOwner = await service.findOne(merchantBTemplateId, merchantB.merchantId);
    expect(asOwner.id).toBe(merchantBTemplateId);
  });
});

describe('A library preset: readable/clonable by any merchant, never forkable or archivable directly (real DB, D-33 — confirmed unchanged)', () => {
  let merchant: ScratchMerchant;
  let presetId: string;

  beforeAll(async () => {
    merchant = await createScratchMerchant();
    const preset = await prisma.template.create({
      data: {
        id: uniqueId('preset'),
        merchantId: null,
        name: 'W-3 itest preset',
        billType: 'RECEIPT',
        layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] },
        isHead: true,
      },
    });
    presetId = preset.id;
  });

  afterAll(async () => {
    await cleanupMerchant(merchant);
    await prisma.template.deleteMany({ where: { id: presetId } });
  });

  it('findOne and clone succeed for an arbitrary real merchant; save and archive on the preset itself are refused (422, not 404)', async () => {
    await expect(service.findOne(presetId, merchant.merchantId)).resolves.toMatchObject({ id: presetId });
    const cloned = await service.clone(presetId, merchant.merchantId);
    expect(cloned.merchantId).toBe(merchant.merchantId);
    await prisma.template.deleteMany({ where: { id: cloned.id } });

    await expect(service.save(presetId, { layoutSchema: { blocks: [] } }, merchant.merchantId)).rejects.toBeInstanceOf(
      UnprocessableEntityException,
    );
  });
});

describe('/demo/templates non-interference (real DB, W-3 / D-49) — same standard H-3 held for the public bill page', () => {
  const SEED_MERCHANT_ID = 'seed-merchant-demo';
  let merchant: ScratchMerchant;

  it("a real portal-side fork against a DIFFERENT merchant leaves seed-merchant-demo's own template list byte-identical", async () => {
    const before = await service.list(SEED_MERCHANT_ID);

    merchant = await createScratchMerchant();
    const parent = await createOwnTemplate(merchant);
    await service.save(
      parent.id,
      {
        layoutSchema: {
          blocks: [
            { id: 'blk_1', type: 'HEADER', order: 1, props: {}, visible: true, width: 'full' },
            { id: 'blk_2', type: 'ITEMS', order: 2, props: {}, visible: true, width: 'full' },
          ],
        },
      },
      merchant.merchantId,
    );

    const after = await service.list(SEED_MERCHANT_ID);
    expect(after).toEqual(before);

    await cleanupMerchant(merchant);
  });
});

// S-11 (D-63): the partial unique index Template(merchantId, name) WHERE
// isHead = true. Real Postgres only — a mocked PrismaService cannot prove the
// DB itself does the rejecting.
describe('S-11 / D-63: partial unique index on (merchantId, name) WHERE isHead = true (real DB)', () => {
  let merchant: ScratchMerchant;
  let presetId: string;

  async function rawInsertTemplate(opts: { id: string; merchantId: string | null; name: string; isHead: boolean }) {
    return prisma.$executeRaw`
      INSERT INTO "Template" ("id", "merchantId", "name", "billType", "layoutSchema", "isHead", "updatedAt")
      VALUES (${opts.id}, ${opts.merchantId}, ${opts.name}, ${'RECEIPT'}::"BillType", ${'{}'}::jsonb, ${opts.isHead}, now())
    `;
  }

  beforeAll(async () => {
    merchant = await createScratchMerchant();
    const preset = await prisma.template.create({
      data: {
        id: uniqueId('preset'),
        merchantId: null,
        name: 'S-11 itest starter',
        billType: 'RECEIPT',
        layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] },
        isHead: true,
      },
    });
    presetId = preset.id;
  });

  afterAll(async () => {
    await cleanupMerchant(merchant);
    await prisma.template.deleteMany({ where: { id: presetId } });
    await prisma.template.deleteMany({ where: { name: { in: ['S-11 itest shared starter name', 'S-11 itest head name'] } } });
  });

  it('a direct INSERT of a second isHead=true row with an existing (merchantId, name) is rejected BY POSTGRES (P2002), not by app code', async () => {
    const firstId = uniqueId('tpl');
    await createOwnTemplateWithName(merchant, 'S-11 itest head name', true, firstId);

    const err = await rawInsertTemplate({
      id: uniqueId('tpl'),
      merchantId: merchant.merchantId,
      name: 'S-11 itest head name',
      isHead: true,
    }).catch((e: unknown) => e);

    // The rejection is the database's own unique-violation. A raw INSERT
    // bypasses Prisma's ORM layer, so it surfaces as P2010 ("raw query failed")
    // carrying Postgres's SQLSTATE 23505 (unique_violation) for the
    // (merchantId, name) key — no service or NestException layer is involved.
    expect(err).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    const e = err as Prisma.PrismaClientKnownRequestError;
    expect(e.code).toBe('P2010');
    const meta = (e.meta ?? {}) as { code?: string; message?: string };
    expect(meta.code).toBe('23505');
    expect(meta.message).toContain('merchantId');
    expect(meta.message).toContain('already exists');
  });

  it('the same INSERT with isHead=false succeeds — superseded versions keep their names harmlessly (D-63)', async () => {
    await expect(
      rawInsertTemplate({
        id: uniqueId('tpl'),
        merchantId: merchant.merchantId,
        name: 'S-11 itest head name',
        isHead: false,
      }),
    ).resolves.toBe(1);
  });

  it('two merchantId=NULL (starter) rows may share a name — Postgres ignores NULLs in the unique index (D-63)', async () => {
    await expect(
      rawInsertTemplate({ id: uniqueId('tpl'), merchantId: null, name: 'S-11 itest shared starter name', isHead: true }),
    ).resolves.toBe(1);
    await expect(
      rawInsertTemplate({ id: uniqueId('tpl'), merchantId: null, name: 'S-11 itest shared starter name', isHead: true }),
    ).resolves.toBe(1);
  });

  it('clone() twice on the same starter by the same merchant → first succeeds, second is a named 409 TEMPLATE_NAME_TAKEN (Option B), not a raw 500', async () => {
    const first = await service.clone(presetId, merchant.merchantId);
    expect(first.merchantId).toBe(merchant.merchantId);
    expect(first.name).toBe('S-11 itest starter');

    const err = await service.clone(presetId, merchant.merchantId).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({ error_code: 'TEMPLATE_NAME_TAKEN' });

    // The failed second clone wrote nothing.
    const clonesOfName = await prisma.template.count({
      where: { merchantId: merchant.merchantId, name: 'S-11 itest starter' },
    });
    expect(clonesOfName).toBe(1);
  });

  it('save() on a normal lineage is unaffected — the fork flips the parent out of the index first, so name reuse within a lineage never trips it (D-63)', async () => {
    const parent = await createOwnTemplateWithName(merchant, 'S-11 itest lineage', true, uniqueId('tpl'));
    const forked = await service.save(
      parent.id,
      {
        layoutSchema: {
          blocks: [
            { id: 'blk_1', type: 'HEADER', order: 1, props: {}, visible: true, width: 'full' },
            { id: 'blk_2', type: 'ITEMS', order: 2, props: {}, visible: true, width: 'full' },
          ],
        },
      },
      merchant.merchantId,
    );
    expect(forked.name).toBe('S-11 itest lineage');
    expect(forked.isHead).toBe(true);
    const parentRow = await prisma.template.findUniqueOrThrow({ where: { id: parent.id } });
    expect(parentRow.isHead).toBe(false);
    // Exactly one live head by this name.
    const liveHeads = await prisma.template.count({
      where: { merchantId: merchant.merchantId, name: 'S-11 itest lineage', isHead: true },
    });
    expect(liveHeads).toBe(1);
  });
});

async function createOwnTemplateWithName(merchant: ScratchMerchant, name: string, isHead: boolean, id: string) {
  return prisma.template.create({
    data: {
      id,
      merchantId: merchant.merchantId,
      name,
      billType: 'RECEIPT',
      layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] },
      isHead,
    },
  });
}
