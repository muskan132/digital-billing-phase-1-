import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { MAX_NAME_ALLOCATION_RETRIES, SaveTemplateBody, TemplatesService } from './templates.service';

// A-4: merchantId is now a parameter, resolved by the caller (DemoOnlyGuard
// today) — this is the test's own stand-in for that, not read by the service.
const MERCHANT_ID = 'seed-merchant-demo';

const LIBRARY_TEMPLATE = {
  id: 'seed-template-receipt',
  merchantId: null,
  isHead: true,
  archivedAt: null,
};

const MERCHANT_OWNED_TEMPLATE = {
  id: 'tpl-merchant-owned',
  merchantId: 'seed-merchant-demo',
  billType: 'RECEIPT',
  isHead: true,
  archivedAt: null,
};

const PARENT_TEMPLATE = {
  id: 'tpl-parent',
  merchantId: 'seed-merchant-demo',
  name: 'My Retail Template',
  billType: 'TAX_INVOICE',
  skeleton: 'RETAIL',
  version: 2,
  isHead: true,
  archivedAt: null,
};

const VALID_BODY: SaveTemplateBody = {
  layoutSchema: {
    blocks: [
      { id: 'blk_1', type: 'HEADER', order: 1, props: {}, visible: true, width: 'full' },
      { id: 'blk_2', type: 'ITEMS', order: 2, props: {}, visible: true, width: 'full' },
    ],
  },
};

// A P2002 shaped like the partial name index's violation (S-11).
function fakeNameP2002() {
  return new Prisma.PrismaClientKnownRequestError('unique violation', {
    code: 'P2002',
    clientVersion: 'test',
    meta: { target: 'Template_merchantId_name_head_key' },
  });
}

describe('TemplatesService', () => {
  let templateFindMany: jest.Mock;
  let templateFindFirst: jest.Mock;
  let templateCreate: jest.Mock;
  let templateUpdate: jest.Mock;
  let merchantUpdate: jest.Mock;
  let merchantFindUnique: jest.Mock;
  let txTemplateUpdateMany: jest.Mock;
  let txTemplateFindFirst: jest.Mock;
  let txTemplateCreate: jest.Mock;
  let txMerchantUpdateMany: jest.Mock;
  let txTemplateFindMany: jest.Mock;
  let txTemplateDeleteMany: jest.Mock;
  let txBillCount: jest.Mock;
  let txMerchantFindUniqueOrThrow: jest.Mock;
  let transactionFn: jest.Mock;
  let service: TemplatesService;

  beforeEach(() => {
    templateFindMany = jest.fn().mockResolvedValue([LIBRARY_TEMPLATE, MERCHANT_OWNED_TEMPLATE]);
    templateFindFirst = jest.fn().mockResolvedValue(LIBRARY_TEMPLATE);
    templateCreate = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'tpl-cloned', ...data }));
    templateUpdate = jest.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
    merchantUpdate = jest.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
    merchantFindUnique = jest.fn().mockResolvedValue({ id: 'seed-merchant-demo', defaultReceiptTemplateId: 'some-other-template' });

    txTemplateUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    // F-1: allocateName's probe — null = the candidate name is free.
    txTemplateFindFirst = jest.fn().mockResolvedValue(null);
    txTemplateCreate = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'tpl-forked', ...data }));
    txMerchantUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

    // F-4: deleteLineage's tx surface.
    txTemplateFindMany = jest.fn().mockResolvedValue([]); // no children by default
    txTemplateDeleteMany = jest.fn().mockResolvedValue({ count: 1 });
    txBillCount = jest.fn().mockResolvedValue(0);
    txMerchantFindUniqueOrThrow = jest.fn().mockResolvedValue({ defaultReceiptTemplateId: null, defaultTaxInvoiceTemplateId: null });

    transactionFn = jest.fn().mockImplementation((cb) =>
      cb({
        template: {
          updateMany: txTemplateUpdateMany,
          findFirst: txTemplateFindFirst,
          create: txTemplateCreate,
          findMany: txTemplateFindMany,
          findUniqueOrThrow: jest.fn((args) => Promise.resolve({ id: (args as { where: { id: string } }).where.id, parentTemplateId: null })),
          deleteMany: txTemplateDeleteMany,
        },
        bill: { count: txBillCount },
        merchant: { updateMany: txMerchantUpdateMany, findUniqueOrThrow: txMerchantFindUniqueOrThrow },
      }),
    );

    const prisma = {
      template: { findMany: templateFindMany, findFirst: templateFindFirst, create: templateCreate, update: templateUpdate },
      merchant: { update: merchantUpdate, findUnique: merchantFindUnique },
      $transaction: transactionFn,
    } as unknown as PrismaService;
    service = new TemplatesService(prisma);
  });

  describe('list', () => {
    it('queries for head, non-archived rows scoped to the seeded merchant or library presets', async () => {
      await service.list(MERCHANT_ID);

      expect(templateFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [{ merchantId: 'seed-merchant-demo' }, { merchantId: null }],
            isHead: true,
            archivedAt: null,
          },
        }),
      );
    });

    it('returns whatever the scoped query resolves', async () => {
      const result = await service.list(MERCHANT_ID);
      expect(result).toEqual([LIBRARY_TEMPLATE, MERCHANT_OWNED_TEMPLATE]);
    });
  });

  describe('findOne', () => {
    it('queries by id within the same merchant/library scope, not restricted to isHead', async () => {
      await service.findOne('seed-template-receipt', MERCHANT_ID);

      expect(templateFindFirst).toHaveBeenCalledWith({
        where: {
          id: 'seed-template-receipt',
          OR: [{ merchantId: 'seed-merchant-demo' }, { merchantId: null }],
          archivedAt: null,
        },
      });
    });

    it('returns the template when found', async () => {
      const result = await service.findOne('seed-template-receipt', MERCHANT_ID);
      expect(result).toEqual(LIBRARY_TEMPLATE);
    });

    it('throws NotFoundException when the template is missing or out of scope', async () => {
      templateFindFirst.mockResolvedValue(null);
      await expect(service.findOne('unknown', MERCHANT_ID)).rejects.toThrow(NotFoundException);
    });
  });

  describe('save (C-2 fork-on-write)', () => {
    beforeEach(() => {
      templateFindFirst.mockResolvedValue(PARENT_TEMPLATE);
    });

    it('creates exactly one new row with parentTemplateId/version/isHead set from the parent', async () => {
      const result = await service.save(PARENT_TEMPLATE.id, VALID_BODY, MERCHANT_ID);

      expect(transactionFn).toHaveBeenCalledTimes(1);
      expect(txTemplateCreate).toHaveBeenCalledTimes(1);
      expect(txTemplateCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          merchantId: PARENT_TEMPLATE.merchantId,
          name: PARENT_TEMPLATE.name,
          billType: PARENT_TEMPLATE.billType,
          skeleton: PARENT_TEMPLATE.skeleton,
          version: PARENT_TEMPLATE.version + 1,
          parentTemplateId: PARENT_TEMPLATE.id,
          isHead: true,
        }),
      });
      expect(result.id).toBe('tpl-forked');
    });

    it('reconstructs layoutSchema server-side using the parent skeleton, not anything from the request', async () => {
      await service.save(PARENT_TEMPLATE.id, VALID_BODY, MERCHANT_ID);

      const createCall = txTemplateCreate.mock.calls[0][0];
      expect(createCall.data.layoutSchema).toEqual({
        schemaVersion: 2,
        skeleton: PARENT_TEMPLATE.skeleton,
        blocks: VALID_BODY.layoutSchema.blocks,
      });
    });

    it('flips the parent isHead to false without archiving it, by default', async () => {
      await service.save(PARENT_TEMPLATE.id, VALID_BODY, MERCHANT_ID);

      expect(txTemplateUpdateMany).toHaveBeenCalledWith({
        where: { id: PARENT_TEMPLATE.id, isHead: true },
        data: { isHead: false },
      });
    });

    it('archivePrevious: true sets archivedAt on the same parent-flip statement', async () => {
      await service.save(PARENT_TEMPLATE.id, { ...VALID_BODY, archivePrevious: true }, MERCHANT_ID);

      expect(txTemplateUpdateMany).toHaveBeenCalledWith({
        where: { id: PARENT_TEMPLATE.id, isHead: true },
        data: { isHead: false, archivedAt: expect.any(Date) },
      });
    });

    it('repoints Merchant.defaultTaxInvoiceTemplateId unconditionally by where-clause match, dispatched from the parent billType (no separate read)', async () => {
      // PARENT_TEMPLATE.billType is TAX_INVOICE (S-10/D-60 dispatch).
      await service.save(PARENT_TEMPLATE.id, VALID_BODY, MERCHANT_ID);

      expect(txMerchantUpdateMany).toHaveBeenCalledWith({
        where: { id: PARENT_TEMPLATE.merchantId, defaultTaxInvoiceTemplateId: PARENT_TEMPLATE.id },
        data: { defaultTaxInvoiceTemplateId: 'tpl-forked' },
      });
    });

    it('rejects a malformed layoutSchema.blocks before opening a transaction — zero writes', async () => {
      await expect(service.save(PARENT_TEMPLATE.id, { layoutSchema: { blocks: 'not-an-array' as never } }, MERCHANT_ID)).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(transactionFn).not.toHaveBeenCalled();
    });

    it('rejects a non-boolean archivePrevious before opening a transaction — zero writes', async () => {
      await expect(service.save(PARENT_TEMPLATE.id, { ...VALID_BODY, archivePrevious: 'yes' as never }, MERCHANT_ID)).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(transactionFn).not.toHaveBeenCalled();
    });

    it('rejects a document failing T-6 validation before opening a transaction — zero writes', async () => {
      const noHeader: SaveTemplateBody = {
        layoutSchema: { blocks: [{ id: 'blk_1', type: 'ITEMS', order: 1, props: {}, visible: true, width: 'full' }] },
      };
      await expect(service.save(PARENT_TEMPLATE.id, noHeader, MERCHANT_ID)).rejects.toThrow(UnprocessableEntityException);
      expect(transactionFn).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the target template does not exist or is out of scope', async () => {
      templateFindFirst.mockResolvedValue(null);
      await expect(service.save('unknown', VALID_BODY, MERCHANT_ID)).rejects.toThrow(NotFoundException);
      expect(transactionFn).not.toHaveBeenCalled();
    });

    it('refuses to fork a library preset (merchantId: null) — zero writes', async () => {
      templateFindFirst.mockResolvedValue({ ...PARENT_TEMPLATE, merchantId: null });
      await expect(service.save(PARENT_TEMPLATE.id, VALID_BODY, MERCHANT_ID)).rejects.toThrow(UnprocessableEntityException);
      expect(transactionFn).not.toHaveBeenCalled();
    });

    it('refuses to fork a non-head (stale) version — zero writes', async () => {
      templateFindFirst.mockResolvedValue({ ...PARENT_TEMPLATE, isHead: false });
      await expect(service.save(PARENT_TEMPLATE.id, VALID_BODY, MERCHANT_ID)).rejects.toThrow(UnprocessableEntityException);
      expect(transactionFn).not.toHaveBeenCalled();
    });

    it('aborts with ConflictException when isHead already flipped concurrently — no row created', async () => {
      txTemplateUpdateMany.mockResolvedValue({ count: 0 });

      await expect(service.save(PARENT_TEMPLATE.id, VALID_BODY, MERCHANT_ID)).rejects.toThrow(ConflictException);
      expect(txTemplateCreate).not.toHaveBeenCalled();
      expect(txMerchantUpdateMany).not.toHaveBeenCalled();
    });

    // ---- F-1: optional rename ----

    it('no `name` → keeps the parent name, opens exactly one transaction, and never probes the allocator', async () => {
      await service.save(PARENT_TEMPLATE.id, VALID_BODY, MERCHANT_ID);

      expect(transactionFn).toHaveBeenCalledTimes(1);
      expect(txTemplateFindFirst).not.toHaveBeenCalled();
      expect(txTemplateCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ name: PARENT_TEMPLATE.name }) });
    });

    it('a `name` → allocator probes for a free name INSIDE the transaction and the forked row carries it', async () => {
      await service.save(PARENT_TEMPLATE.id, { ...VALID_BODY, name: 'Renamed Template' }, MERCHANT_ID);

      expect(txTemplateFindFirst).toHaveBeenCalledWith({
        where: { merchantId: PARENT_TEMPLATE.merchantId, name: 'Renamed Template', isHead: true },
        select: { id: true },
      });
      expect(txTemplateCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ name: 'Renamed Template' }) });
    });

    it('a `name` is trimmed before allocation', async () => {
      await service.save(PARENT_TEMPLATE.id, { ...VALID_BODY, name: '  Padded  ' }, MERCHANT_ID);
      expect(txTemplateCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ name: 'Padded' }) });
    });

    it.each(['   ', 42, ''])('rejects a blank/non-string `name` (%p) before opening a transaction — zero writes', async (bad) => {
      await expect(service.save(PARENT_TEMPLATE.id, { ...VALID_BODY, name: bad as never }, MERCHANT_ID)).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(transactionFn).not.toHaveBeenCalled();
    });

    it('the P2002 retry is bounded — a permanently conflicting name fails cleanly after exactly MAX_NAME_ALLOCATION_RETRIES attempts, never loops', async () => {
      txTemplateCreate.mockRejectedValue(fakeNameP2002());

      const err = await service.save(PARENT_TEMPLATE.id, { ...VALID_BODY, name: 'Always Taken' }, MERCHANT_ID).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ error_code: 'TEMPLATE_NAME_TAKEN' });
      expect(transactionFn).toHaveBeenCalledTimes(MAX_NAME_ALLOCATION_RETRIES);
    });

    it('a no-name save does NOT retry on P2002 — it surfaces the 409 on the first attempt (retrying the parent name would loop)', async () => {
      txTemplateCreate.mockRejectedValue(fakeNameP2002());

      const err = await service.save(PARENT_TEMPLATE.id, VALID_BODY, MERCHANT_ID).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ error_code: 'TEMPLATE_NAME_TAKEN' });
      expect(transactionFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('saveAs (F-2 / D-62)', () => {
    const SAVE_AS_BODY = { name: 'My Copy', layoutSchema: { blocks: VALID_BODY.layoutSchema.blocks } };

    it('writes exactly one new row into a fresh lineage from a STARTER — merchantId = session, name, version 1, parentTemplateId null, isHead true; no transaction, no default repoint', async () => {
      templateFindFirst.mockResolvedValueOnce(LIBRARY_TEMPLATE).mockResolvedValue(null);
      const result = await service.saveAs(LIBRARY_TEMPLATE.id, SAVE_AS_BODY, MERCHANT_ID);

      expect(templateCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          merchantId: 'seed-merchant-demo',
          name: 'My Copy',
          version: 1,
          parentTemplateId: null,
          isHead: true,
        }),
      });
      expect(templateCreate).toHaveBeenCalledTimes(1);
      expect(transactionFn).not.toHaveBeenCalled();
      expect(merchantUpdate).not.toHaveBeenCalled();
      expect(result.id).toBe('tpl-cloned');
    });

    it('works from the merchant\'s OWN template too — no CANNOT_CLONE_MERCHANT_TEMPLATE refusal (D-62)', async () => {
      templateFindFirst.mockResolvedValueOnce(MERCHANT_OWNED_TEMPLATE).mockResolvedValue(null);
      await expect(service.saveAs(MERCHANT_OWNED_TEMPLATE.id, SAVE_AS_BODY, MERCHANT_ID)).resolves.toBeDefined();
      expect(templateCreate).toHaveBeenCalledTimes(1);
    });

    it('reconstructs skeleton and billType from the SOURCE, and layoutSchema from the edited body', async () => {
      templateFindFirst.mockResolvedValueOnce(PARENT_TEMPLATE).mockResolvedValue(null);
      await service.saveAs(PARENT_TEMPLATE.id, SAVE_AS_BODY, MERCHANT_ID);

      const createCall = templateCreate.mock.calls[0][0];
      expect(createCall.data.skeleton).toBe(PARENT_TEMPLATE.skeleton);
      expect(createCall.data.billType).toBe(PARENT_TEMPLATE.billType);
      expect(createCall.data.layoutSchema).toEqual({
        schemaVersion: 2,
        skeleton: PARENT_TEMPLATE.skeleton,
        blocks: VALID_BODY.layoutSchema.blocks,
      });
    });

    it('the allocator suffixes a name the merchant already holds to "(1)"', async () => {
      templateFindFirst
        .mockResolvedValueOnce(LIBRARY_TEMPLATE) // source lookup
        .mockResolvedValueOnce({ id: 'existing' }) // probe: "My Copy" taken
        .mockResolvedValue(null); // probe: "My Copy (1)" free
      await service.saveAs(LIBRARY_TEMPLATE.id, SAVE_AS_BODY, MERCHANT_ID);
      expect(templateCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ name: 'My Copy (1)' }) });
    });

    it('throws NotFoundException when the source is missing or out of scope — zero writes', async () => {
      templateFindFirst.mockResolvedValue(null);
      await expect(service.saveAs('unknown', SAVE_AS_BODY, MERCHANT_ID)).rejects.toThrow(NotFoundException);
      expect(templateCreate).not.toHaveBeenCalled();
    });

    it.each(['   ', 42, '', undefined])('rejects a missing/blank/non-string name (%p) before any lookup — zero writes', async (bad) => {
      await expect(service.saveAs(LIBRARY_TEMPLATE.id, { ...SAVE_AS_BODY, name: bad as never }, MERCHANT_ID)).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(templateFindFirst).not.toHaveBeenCalled();
      expect(templateCreate).not.toHaveBeenCalled();
    });

    it('rejects a document failing validateLayoutSchema (D-31 — this is the seed-template-utility case) — zero writes', async () => {
      templateFindFirst.mockResolvedValueOnce(LIBRARY_TEMPLATE).mockResolvedValue(null);
      const noHeader = {
        name: 'X',
        layoutSchema: { blocks: [{ id: 'blk_1', type: 'ITEMS', order: 1, props: {}, visible: true, width: 'full' }] },
      };
      const err = await service.saveAs(LIBRARY_TEMPLATE.id, noHeader, MERCHANT_ID).catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ error_code: 'INVALID_LAYOUT_SCHEMA' });
      expect(templateCreate).not.toHaveBeenCalled();
    });

    it('the P2002 retry is bounded — fails cleanly with 409 after exactly MAX_NAME_ALLOCATION_RETRIES attempts', async () => {
      templateFindFirst.mockResolvedValueOnce(LIBRARY_TEMPLATE).mockResolvedValue(null);
      templateCreate.mockRejectedValue(fakeNameP2002());

      const err = await service.saveAs(LIBRARY_TEMPLATE.id, SAVE_AS_BODY, MERCHANT_ID).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ error_code: 'TEMPLATE_NAME_TAKEN' });
      expect(templateCreate).toHaveBeenCalledTimes(MAX_NAME_ALLOCATION_RETRIES);
    });
  });

  describe('create (F-3 / D-66 / D-73)', () => {
    const OK = { name: 'From Scratch', billType: 'RECEIPT', skeleton: 'MINIMALIST' };

    it('writes one new row: version 1, parentTemplateId null, isHead true, merchantId = session, billType/skeleton from the body', async () => {
      const result = await service.create(OK, MERCHANT_ID);
      expect(templateCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          merchantId: 'seed-merchant-demo',
          name: 'From Scratch',
          billType: 'RECEIPT',
          skeleton: 'MINIMALIST',
          version: 1,
          parentTemplateId: null,
          isHead: true,
        }),
      });
      // Never a transaction, never the allocator (D-73 — no auto-suffix on create).
      expect(transactionFn).not.toHaveBeenCalled();
      expect(result.id).toBe('tpl-cloned');
    });

    it('the built document is a visible HEADER + a visible ITEMS and nothing else (D-66)', async () => {
      await service.create(OK, MERCHANT_ID);
      const doc = templateCreate.mock.calls[0][0].data.layoutSchema as {
        schemaVersion: number;
        skeleton: string;
        blocks: { type: string; visible: boolean; order: number }[];
      };
      expect(doc.schemaVersion).toBe(2);
      expect(doc.skeleton).toBe('MINIMALIST');
      expect(doc.blocks.map((b) => b.type)).toEqual(['HEADER', 'ITEMS']);
      expect(doc.blocks.every((b) => b.visible === true)).toBe(true);
    });

    it.each(['MINIMALIST', 'COMPACT_THERMAL', 'TAX_COMPLIANT', 'RETAIL', 'RESTAURANT'])(
      'accepts the %s skeleton',
      async (skeleton) => {
        await expect(service.create({ ...OK, skeleton }, MERCHANT_ID)).resolves.toBeDefined();
      },
    );

    it('rejects skeleton UTILITY with SKELETON_NOT_AVAILABLE_FOR_CREATE (D-73), before any write', async () => {
      const err = await service.create({ ...OK, skeleton: 'UTILITY' }, MERCHANT_ID).catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ error_code: 'SKELETON_NOT_AVAILABLE_FOR_CREATE' });
      expect(templateCreate).not.toHaveBeenCalled();
    });

    it('rejects an unrecognised skeleton with INVALID_SKELETON (D-40), before any write', async () => {
      const err = await service.create({ ...OK, skeleton: 'FOOBAR' }, MERCHANT_ID).catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ error_code: 'INVALID_SKELETON' });
      expect(templateCreate).not.toHaveBeenCalled();
    });

    it('rejects an unrecognised billType with INVALID_BILL_TYPE, before any write', async () => {
      const err = await service.create({ ...OK, billType: 'INVOICE' }, MERCHANT_ID).catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ error_code: 'INVALID_BILL_TYPE' });
      expect(templateCreate).not.toHaveBeenCalled();
    });

    it.each([{ name: undefined }, { name: '   ' }, { billType: undefined }, { skeleton: undefined }])(
      'rejects a missing/blank required field (%p) with 422, before any write',
      async (override) => {
        await expect(service.create({ ...OK, ...override } as never, MERCHANT_ID)).rejects.toBeInstanceOf(UnprocessableEntityException);
        expect(templateCreate).not.toHaveBeenCalled();
      },
    );

    it('a name the merchant already holds → 409 TEMPLATE_NAME_TAKEN, no retry, no suffix (D-73)', async () => {
      templateCreate.mockRejectedValue(fakeNameP2002());
      const err = await service.create(OK, MERCHANT_ID).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect((err as ConflictException).getResponse()).toMatchObject({ error_code: 'TEMPLATE_NAME_TAKEN' });
      expect(templateCreate).toHaveBeenCalledTimes(1);
    });

    it('trims the name', async () => {
      await service.create({ ...OK, name: '  Padded  ' }, MERCHANT_ID);
      expect(templateCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ name: 'Padded' }) });
    });
  });

  describe('setDefault (C-3)', () => {
    it('repoints Merchant.defaultReceiptTemplateId at the given head template, dispatched from its billType (S-10/D-60)', async () => {
      templateFindFirst.mockResolvedValue(MERCHANT_OWNED_TEMPLATE);
      await service.setDefault(MERCHANT_OWNED_TEMPLATE.id, MERCHANT_ID);

      expect(merchantUpdate).toHaveBeenCalledWith({
        where: { id: 'seed-merchant-demo' },
        data: { defaultReceiptTemplateId: MERCHANT_OWNED_TEMPLATE.id },
      });
    });

    it('repoints Merchant.defaultTaxInvoiceTemplateId instead when the template is a TAX_INVOICE', async () => {
      templateFindFirst.mockResolvedValue({ ...MERCHANT_OWNED_TEMPLATE, billType: 'TAX_INVOICE' });
      await service.setDefault(MERCHANT_OWNED_TEMPLATE.id, MERCHANT_ID);

      expect(merchantUpdate).toHaveBeenCalledWith({
        where: { id: 'seed-merchant-demo' },
        data: { defaultTaxInvoiceTemplateId: MERCHANT_OWNED_TEMPLATE.id },
      });
    });

    it('throws NotFoundException when the template is missing or out of scope', async () => {
      templateFindFirst.mockResolvedValue(null);
      await expect(service.setDefault('unknown', MERCHANT_ID)).rejects.toThrow(NotFoundException);
      expect(merchantUpdate).not.toHaveBeenCalled();
    });

    it('refuses to set a non-head version as default', async () => {
      templateFindFirst.mockResolvedValue({ ...MERCHANT_OWNED_TEMPLATE, isHead: false });
      await expect(service.setDefault(MERCHANT_OWNED_TEMPLATE.id, MERCHANT_ID)).rejects.toThrow(UnprocessableEntityException);
      expect(merchantUpdate).not.toHaveBeenCalled();
    });
  });

  describe('archive (C-3)', () => {
    it('sets archivedAt on a merchant-owned head template that is not the current default', async () => {
      templateFindFirst.mockResolvedValue(MERCHANT_OWNED_TEMPLATE);
      merchantFindUnique.mockResolvedValue({ id: 'seed-merchant-demo', defaultReceiptTemplateId: 'some-other-template' });

      const result = await service.archive(MERCHANT_OWNED_TEMPLATE.id, MERCHANT_ID);

      expect(templateUpdate).toHaveBeenCalledWith({
        where: { id: MERCHANT_OWNED_TEMPLATE.id },
        data: { archivedAt: expect.any(Date) },
      });
      expect(result.archivedAt).toBeInstanceOf(Date);
    });

    it('refuses to archive the current default, naming the reason, zero writes', async () => {
      templateFindFirst.mockResolvedValue(MERCHANT_OWNED_TEMPLATE);
      merchantFindUnique.mockResolvedValue({ id: 'seed-merchant-demo', defaultReceiptTemplateId: MERCHANT_OWNED_TEMPLATE.id });

      await expect(service.archive(MERCHANT_OWNED_TEMPLATE.id, MERCHANT_ID)).rejects.toThrow(UnprocessableEntityException);
      expect(templateUpdate).not.toHaveBeenCalled();
    });

    it('refuses to archive the current TAX_INVOICE default, dispatched from the template billType (S-10/D-60)', async () => {
      templateFindFirst.mockResolvedValue({ ...MERCHANT_OWNED_TEMPLATE, billType: 'TAX_INVOICE' });
      merchantFindUnique.mockResolvedValue({ id: 'seed-merchant-demo', defaultTaxInvoiceTemplateId: MERCHANT_OWNED_TEMPLATE.id });

      await expect(service.archive(MERCHANT_OWNED_TEMPLATE.id, MERCHANT_ID)).rejects.toThrow(UnprocessableEntityException);
      expect(templateUpdate).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the template is missing, out of scope, or already archived', async () => {
      templateFindFirst.mockResolvedValue(null);
      await expect(service.archive('unknown', MERCHANT_ID)).rejects.toThrow(NotFoundException);
      expect(templateUpdate).not.toHaveBeenCalled();
    });

    it('refuses to archive a non-head version', async () => {
      templateFindFirst.mockResolvedValue({ ...MERCHANT_OWNED_TEMPLATE, isHead: false });
      await expect(service.archive(MERCHANT_OWNED_TEMPLATE.id, MERCHANT_ID)).rejects.toThrow(UnprocessableEntityException);
      expect(templateUpdate).not.toHaveBeenCalled();
    });
  });

  describe('deleteLineage (F-4 / D-64 / D-74)', () => {
    beforeEach(() => {
      // Target found, scoped to the session merchant, is a root (no walk-up).
      txTemplateFindFirst.mockResolvedValue({ id: 'v1', parentTemplateId: null });
    });

    it('404 when the target is out of scope (wrong merchant / nonexistent / starter) — no walk, no delete', async () => {
      txTemplateFindFirst.mockResolvedValue(null);
      await expect(service.deleteLineage('nope', MERCHANT_ID)).rejects.toThrow(NotFoundException);
      expect(txBillCount).not.toHaveBeenCalled();
      expect(txTemplateDeleteMany).not.toHaveBeenCalled();
    });

    it('the bill check is over EVERY collected lineage id (templateId IN [...]), not just the target', async () => {
      // walk-down finds one child, then no more.
      txTemplateFindMany.mockResolvedValueOnce([{ id: 'v2' }]).mockResolvedValue([]);
      await service.deleteLineage('v1', MERCHANT_ID);
      expect(txBillCount).toHaveBeenCalledWith({ where: { templateId: { in: expect.arrayContaining(['v1', 'v2']) } } });
      expect((txBillCount.mock.calls[0][0].where.templateId.in as string[]).sort()).toEqual(['v1', 'v2']);
    });

    it('refuses with TEMPLATE_HAS_ISSUED_BILLS when any version has a bill — no delete', async () => {
      txBillCount.mockResolvedValue(1);
      const err = await service.deleteLineage('v1', MERCHANT_ID).catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ error_code: 'TEMPLATE_HAS_ISSUED_BILLS' });
      expect(txTemplateDeleteMany).not.toHaveBeenCalled();
    });

    it('refuses with CANNOT_DELETE_DEFAULT_TEMPLATE when a lineage id is either default pointer — no delete', async () => {
      txMerchantFindUniqueOrThrow.mockResolvedValue({ defaultReceiptTemplateId: 'v1', defaultTaxInvoiceTemplateId: null });
      const err = await service.deleteLineage('v1', MERCHANT_ID).catch((e) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ error_code: 'CANNOT_DELETE_DEFAULT_TEMPLATE' });
      expect(txTemplateDeleteMany).not.toHaveBeenCalled();
    });

    it('bills are checked BEFORE default (F-4 Q5) — a lineage that is both reports TEMPLATE_HAS_ISSUED_BILLS', async () => {
      txBillCount.mockResolvedValue(1);
      txMerchantFindUniqueOrThrow.mockResolvedValue({ defaultReceiptTemplateId: 'v1', defaultTaxInvoiceTemplateId: null });
      const err = await service.deleteLineage('v1', MERCHANT_ID).catch((e) => e);
      expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ error_code: 'TEMPLATE_HAS_ISSUED_BILLS' });
    });

    it('on success returns { deletedCount } from the single deleteMany over the whole lineage', async () => {
      txTemplateFindMany.mockResolvedValueOnce([{ id: 'v2' }, { id: 'v3' }]).mockResolvedValue([]);
      txTemplateDeleteMany.mockResolvedValue({ count: 3 });
      const result = await service.deleteLineage('v1', MERCHANT_ID);
      expect(result).toEqual({ deletedCount: 3 });
      expect(txTemplateDeleteMany).toHaveBeenCalledWith({ where: { id: { in: expect.arrayContaining(['v1', 'v2', 'v3']) } } });
    });
  });

  describe('getDefaultTemplateId (W-2)', () => {
    // S-10/D-60: deliberately still the RECEIPT pointer only — unchanged
    // dashboard DTO shape until F-6 builds the real two-pointer UI.
    it("returns the merchant's stored defaultReceiptTemplateId", async () => {
      merchantFindUnique.mockResolvedValue({ defaultReceiptTemplateId: 'tpl-parent' });
      await expect(service.getDefaultTemplateId(MERCHANT_ID)).resolves.toBe('tpl-parent');
      expect(merchantFindUnique).toHaveBeenCalledWith({ where: { id: MERCHANT_ID }, select: { defaultReceiptTemplateId: true } });
    });

    it('returns null when the merchant has no default set', async () => {
      merchantFindUnique.mockResolvedValue({ defaultReceiptTemplateId: null });
      await expect(service.getDefaultTemplateId(MERCHANT_ID)).resolves.toBeNull();
    });

    it('returns null (not a crash) if the merchant row is somehow missing', async () => {
      merchantFindUnique.mockResolvedValue(null);
      await expect(service.getDefaultTemplateId(MERCHANT_ID)).resolves.toBeNull();
    });
  });
});
