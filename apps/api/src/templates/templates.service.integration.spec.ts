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
import { MAX_NAME_ALLOCATION_RETRIES, TemplatesService } from './templates.service';

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

// The smallest block array that passes validateLayoutSchema / D-31 (visible
// HEADER + visible ITEMS) — Save As runs the validator, unlike the old clone().
const MINIMAL_VALID_BLOCKS = [
  { id: 'blk_1', type: 'HEADER', order: 1, props: {}, visible: true, width: 'full' },
  { id: 'blk_2', type: 'ITEMS', order: 2, props: {}, visible: true, width: 'full' },
];

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

  it('saveAs', async () => {
    await expect(
      service.saveAs(merchantBTemplateId, { name: 'x', layoutSchema: { blocks: [] } }, merchantA.merchantId),
    ).rejects.toBeInstanceOf(NotFoundException);
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

describe('A library preset: readable/Save-As-able by any merchant, never forkable or archivable directly (real DB, D-33/D-62 — confirmed)', () => {
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

  it('findOne and saveAs succeed for an arbitrary real merchant; save (fork) on the preset itself is still refused (422, not 404)', async () => {
    await expect(service.findOne(presetId, merchant.merchantId)).resolves.toMatchObject({ id: presetId });

    const copy = await service.saveAs(presetId, { name: 'W-3 itest preset copy', layoutSchema: { blocks: MINIMAL_VALID_BLOCKS } }, merchant.merchantId);
    expect(copy.merchantId).toBe(merchant.merchantId);
    expect(copy.parentTemplateId).toBeNull();
    expect(copy.version).toBe(1);
    await prisma.template.deleteMany({ where: { id: copy.id } });

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

  it('saveAs twice from the same starter with the same name → first is the name, second is "(1)" (F-2 supersedes S-11\'s interim 409)', async () => {
    const first = await service.saveAs(presetId, { name: 'S-11 itest starter', layoutSchema: { blocks: MINIMAL_VALID_BLOCKS } }, merchant.merchantId);
    expect(first.merchantId).toBe(merchant.merchantId);
    expect(first.name).toBe('S-11 itest starter');

    const second = await service.saveAs(presetId, { name: 'S-11 itest starter', layoutSchema: { blocks: MINIMAL_VALID_BLOCKS } }, merchant.merchantId);
    expect(second.name).toBe('S-11 itest starter (1)');

    const liveHeads = await prisma.template.count({
      where: { merchantId: merchant.merchantId, isHead: true, name: { in: ['S-11 itest starter', 'S-11 itest starter (1)'] } },
    });
    expect(liveHeads).toBe(2);
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

// F-1 (D-62/D-63): the name allocator + rename on save. Real Postgres only —
// the concurrent-race guarantee cannot be proven with a mocked client.
describe('F-1: name allocation + rename on save (real DB)', () => {
  let merchant: ScratchMerchant;

  const SAVE_BODY = {
    layoutSchema: {
      blocks: [
        { id: 'blk_1', type: 'HEADER', order: 1, props: {}, visible: true, width: 'full' },
        { id: 'blk_2', type: 'ITEMS', order: 2, props: {}, visible: true, width: 'full' },
      ],
    },
  };

  beforeAll(async () => {
    merchant = await createScratchMerchant();
  });

  afterAll(async () => {
    await cleanupMerchant(merchant);
  });

  it('save with NO name preserves the parent name exactly — existing callers unaffected', async () => {
    const parent = await createOwnTemplateWithName(merchant, 'F-1 keep name', true, uniqueId('tpl'));
    const forked = await service.save(parent.id, SAVE_BODY, merchant.merchantId);
    expect(forked.name).toBe('F-1 keep name');
    expect(forked.isHead).toBe(true);
    expect((await prisma.template.findUniqueOrThrow({ where: { id: parent.id } })).isHead).toBe(false);
  });

  it('save with a TAKEN name yields the "(1)" suffix; the taken name and the new one are both live heads', async () => {
    await createOwnTemplateWithName(merchant, 'F-1 taken', true, uniqueId('tpl'));
    const other = await createOwnTemplateWithName(merchant, 'F-1 other lineage', true, uniqueId('tpl'));

    const forked = await service.save(other.id, { ...SAVE_BODY, name: 'F-1 taken' }, merchant.merchantId);
    expect(forked.name).toBe('F-1 taken (1)');

    const liveHeadNames = (
      await prisma.template.findMany({
        where: { merchantId: merchant.merchantId, isHead: true, name: { in: ['F-1 taken', 'F-1 taken (1)'] } },
        select: { name: true },
      })
    )
      .map((t) => t.name)
      .sort();
    expect(liveHeadNames).toEqual(['F-1 taken', 'F-1 taken (1)']);
  });

  it('renaming a lineage to its OWN current name keeps that name (no suffix) — the allocator runs after the parent leaves the index', async () => {
    const parent = await createOwnTemplateWithName(merchant, 'F-1 rename to self', true, uniqueId('tpl'));
    const forked = await service.save(parent.id, { ...SAVE_BODY, name: 'F-1 rename to self' }, merchant.merchantId);
    expect(forked.name).toBe('F-1 rename to self');
  });

  it('two concurrent saves racing for the same name (real Postgres, not mocked) both succeed with DISTINCT names', async () => {
    const a = await createOwnTemplateWithName(merchant, 'F-1 race src A', true, uniqueId('tpl'));
    const b = await createOwnTemplateWithName(merchant, 'F-1 race src B', true, uniqueId('tpl'));

    const [ra, rb] = await Promise.all([
      service.save(a.id, { ...SAVE_BODY, name: 'F-1 race' }, merchant.merchantId),
      service.save(b.id, { ...SAVE_BODY, name: 'F-1 race' }, merchant.merchantId),
    ]);

    expect(new Set([ra.name, rb.name])).toEqual(new Set(['F-1 race', 'F-1 race (1)']));
    expect(ra.isHead).toBe(true);
    expect(rb.isHead).toBe(true);
    // Both are live, distinct rows.
    const liveHeads = await prisma.template.count({
      where: { merchantId: merchant.merchantId, isHead: true, name: { in: ['F-1 race', 'F-1 race (1)'] } },
    });
    expect(liveHeads).toBe(2);
  });

  it('the retry is bounded — a forced permanent conflict fails cleanly after exactly MAX_NAME_ALLOCATION_RETRIES attempts, does not loop', async () => {
    await createOwnTemplateWithName(merchant, 'F-1 perma', true, uniqueId('tpl'));
    const src = await createOwnTemplateWithName(merchant, 'F-1 bounded src', true, uniqueId('tpl'));

    // Force every attempt's allocator output to a name that is already a live
    // head, so every insert hits the real index's P2002.
    const spy = jest.spyOn(service as unknown as { allocateName: () => Promise<string> }, 'allocateName').mockResolvedValue('F-1 perma');
    try {
      const err = await service.save(src.id, { ...SAVE_BODY, name: 'anything' }, merchant.merchantId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ error_code: 'TEMPLATE_NAME_TAKEN' });
      expect(spy).toHaveBeenCalledTimes(MAX_NAME_ALLOCATION_RETRIES);
    } finally {
      spy.mockRestore();
    }

    // The forced-conflict src lineage never produced a new head.
    expect((await prisma.template.findUniqueOrThrow({ where: { id: src.id } })).isHead).toBe(true);
  });
});

// F-2 (D-62): Save As — clean-break copy. Real Postgres only.
describe('F-2: Save As (real DB)', () => {
  let merchant: ScratchMerchant;
  const STARTER_ID = 'seed-template-receipt'; // real seeded starter, merchantId: null

  beforeAll(async () => {
    merchant = await createScratchMerchant();
  });

  afterAll(async () => {
    await cleanupMerchant(merchant);
  });

  it('Save As from a STARTER → exactly one new row (merchantId = session, version 1, parentTemplateId null, isHead true) and the starter row is byte-identical after (isHead, layoutSchema, updatedAt)', async () => {
    const before = await prisma.template.findUniqueOrThrow({ where: { id: STARTER_ID } });
    const countBefore = await prisma.template.count({ where: { merchantId: merchant.merchantId } });

    const copy = await service.saveAs(
      STARTER_ID,
      { name: 'F-2 from starter', layoutSchema: { blocks: MINIMAL_VALID_BLOCKS } },
      merchant.merchantId,
    );

    expect(copy.merchantId).toBe(merchant.merchantId);
    expect(copy.version).toBe(1);
    expect(copy.parentTemplateId).toBeNull();
    expect(copy.isHead).toBe(true);
    expect(await prisma.template.count({ where: { merchantId: merchant.merchantId } })).toBe(countBefore + 1);

    const after = await prisma.template.findUniqueOrThrow({ where: { id: STARTER_ID } });
    expect(after.isHead).toBe(before.isHead);
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    expect(JSON.stringify(after.layoutSchema)).toBe(JSON.stringify(before.layoutSchema));
  });

  it('Save As from the merchant\'s OWN template → two list entries, source isHead still true, neither default pointer changed', async () => {
    const source = await createOwnTemplateWithName(merchant, 'F-2 own source', true, uniqueId('tpl'));
    await prisma.merchant.update({ where: { id: merchant.merchantId }, data: { defaultReceiptTemplateId: source.id } });

    const merchantBefore = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.merchantId } });

    const copy = await service.saveAs(source.id, { name: 'F-2 own copy', layoutSchema: { blocks: MINIMAL_VALID_BLOCKS } }, merchant.merchantId);

    const sourceAfter = await prisma.template.findUniqueOrThrow({ where: { id: source.id } });
    expect(sourceAfter.isHead).toBe(true);

    const merchantAfter = await prisma.merchant.findUniqueOrThrow({ where: { id: merchant.merchantId } });
    expect(merchantAfter.defaultReceiptTemplateId).toBe(merchantBefore.defaultReceiptTemplateId);
    expect(merchantAfter.defaultTaxInvoiceTemplateId).toBe(merchantBefore.defaultTaxInvoiceTemplateId);

    const listIds = (await service.list(merchant.merchantId)).map((t) => t.id);
    expect(listIds).toContain(source.id);
    expect(listIds).toContain(copy.id);
  });

  it('the EDITED body blocks land in the new row, NOT the source\'s stored blocks', async () => {
    const source = await createOwnTemplateWithName(merchant, 'F-2 edited src', true, uniqueId('tpl'));
    // source has blocks: [] (createOwnTemplateWithName). Body carries a real edit.
    const editedBlocks = [
      { id: 'blk_h', type: 'HEADER', order: 1, props: {}, visible: true, width: 'full' },
      { id: 'blk_i', type: 'ITEMS', order: 2, props: { heading: 'EDITED IN BODY' }, visible: true, width: 'full' },
      { id: 'blk_f', type: 'FOOTER', order: 3, props: {}, visible: true, width: 'full' },
    ];

    const copy = await service.saveAs(source.id, { name: 'F-2 edited copy', layoutSchema: { blocks: editedBlocks } }, merchant.merchantId);

    const copyDoc = copy.layoutSchema as { blocks: unknown[] };
    expect(copyDoc.blocks).toEqual(editedBlocks);
    // Source untouched.
    expect((await prisma.template.findUniqueOrThrow({ where: { id: source.id } })).layoutSchema).toEqual({
      schemaVersion: 2,
      skeleton: 'MINIMALIST',
      blocks: [],
    });
  });

  it('skeleton and billType come from the SOURCE, not the body', async () => {
    const copy = await service.saveAs(
      STARTER_ID, // seed-template-receipt: RECEIPT / MINIMALIST
      { name: 'F-2 skeleton check', layoutSchema: { blocks: MINIMAL_VALID_BLOCKS } },
      merchant.merchantId,
    );
    expect(copy.skeleton).toBe('MINIMALIST');
    expect(copy.billType).toBe('RECEIPT');
    expect((copy.layoutSchema as { skeleton: string }).skeleton).toBe('MINIMALIST');
  });

  it('Save As from `seed-template-utility` → a clear D-31-named 422, not a silent/confusing rejection (F-2 Option iii / D-72); zero rows written', async () => {
    const utility = await prisma.template.findUniqueOrThrow({ where: { id: 'seed-template-utility' } });
    const utilityBlocks = (utility.layoutSchema as { blocks: unknown[] }).blocks;
    const countBefore = await prisma.template.count({ where: { merchantId: merchant.merchantId } });

    const err = await service
      .saveAs('seed-template-utility', { name: 'F-2 my utility', layoutSchema: { blocks: utilityBlocks } }, merchant.merchantId)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(UnprocessableEntityException);
    const res = (err as UnprocessableEntityException).getResponse() as { error_code: string; issues: { message: string }[] };
    expect(res.error_code).toBe('INVALID_LAYOUT_SCHEMA');
    expect(res.issues.some((i) => /ITEMS or CHARGES/.test(i.message))).toBe(true);
    expect(await prisma.template.count({ where: { merchantId: merchant.merchantId } })).toBe(countBefore);
  });

  it('name is required — missing/blank → 422 MALFORMED_REQUEST, zero rows', async () => {
    const countBefore = await prisma.template.count({ where: { merchantId: merchant.merchantId } });
    await expect(
      service.saveAs(STARTER_ID, { layoutSchema: { blocks: MINIMAL_VALID_BLOCKS } } as never, merchant.merchantId),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    await expect(
      service.saveAs(STARTER_ID, { name: '   ', layoutSchema: { blocks: MINIMAL_VALID_BLOCKS } }, merchant.merchantId),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(await prisma.template.count({ where: { merchantId: merchant.merchantId } })).toBe(countBefore);
  });

  it('a name the merchant already holds → the allocator suffixes to "(1)" (D-63 on Save As)', async () => {
    await createOwnTemplateWithName(merchant, 'F-2 dup name', true, uniqueId('tpl'));
    const copy = await service.saveAs(STARTER_ID, { name: 'F-2 dup name', layoutSchema: { blocks: MINIMAL_VALID_BLOCKS } }, merchant.merchantId);
    expect(copy.name).toBe('F-2 dup name (1)');
  });

  it('two concurrent Save As racing for the same name (real Postgres) both succeed with DISTINCT names', async () => {
    const [ra, rb] = await Promise.all([
      service.saveAs(STARTER_ID, { name: 'F-2 race', layoutSchema: { blocks: MINIMAL_VALID_BLOCKS } }, merchant.merchantId),
      service.saveAs(STARTER_ID, { name: 'F-2 race', layoutSchema: { blocks: MINIMAL_VALID_BLOCKS } }, merchant.merchantId),
    ]);
    expect(new Set([ra.name, rb.name])).toEqual(new Set(['F-2 race', 'F-2 race (1)']));
  });

  it('the Save As retry is bounded — a forced permanent conflict fails cleanly after exactly MAX_NAME_ALLOCATION_RETRIES attempts', async () => {
    await createOwnTemplateWithName(merchant, 'F-2 perma', true, uniqueId('tpl'));
    const spy = jest
      .spyOn(service as unknown as { allocateName: () => Promise<string> }, 'allocateName')
      .mockResolvedValue('F-2 perma');
    try {
      const err = await service
        .saveAs(STARTER_ID, { name: 'whatever', layoutSchema: { blocks: MINIMAL_VALID_BLOCKS } }, merchant.merchantId)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ error_code: 'TEMPLATE_NAME_TAKEN' });
      expect(spy).toHaveBeenCalledTimes(MAX_NAME_ALLOCATION_RETRIES);
    } finally {
      spy.mockRestore();
    }
  });
});
