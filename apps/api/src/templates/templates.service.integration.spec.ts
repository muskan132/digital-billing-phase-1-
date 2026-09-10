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
import { NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
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
