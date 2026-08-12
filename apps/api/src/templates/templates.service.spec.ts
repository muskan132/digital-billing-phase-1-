import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SaveTemplateBody, TemplatesService } from './templates.service';

const LIBRARY_TEMPLATE = {
  id: 'seed-template-receipt',
  merchantId: null,
  isHead: true,
  archivedAt: null,
};

const MERCHANT_OWNED_TEMPLATE = {
  id: 'tpl-merchant-owned',
  merchantId: 'seed-merchant-demo',
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

describe('TemplatesService', () => {
  let templateFindMany: jest.Mock;
  let templateFindFirst: jest.Mock;
  let templateCreate: jest.Mock;
  let templateUpdate: jest.Mock;
  let merchantUpdate: jest.Mock;
  let merchantFindUnique: jest.Mock;
  let txTemplateUpdateMany: jest.Mock;
  let txTemplateCreate: jest.Mock;
  let txMerchantUpdateMany: jest.Mock;
  let transactionFn: jest.Mock;
  let service: TemplatesService;

  beforeEach(() => {
    templateFindMany = jest.fn().mockResolvedValue([LIBRARY_TEMPLATE, MERCHANT_OWNED_TEMPLATE]);
    templateFindFirst = jest.fn().mockResolvedValue(LIBRARY_TEMPLATE);
    templateCreate = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'tpl-cloned', ...data }));
    templateUpdate = jest.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
    merchantUpdate = jest.fn().mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...data }));
    merchantFindUnique = jest.fn().mockResolvedValue({ id: 'seed-merchant-demo', defaultTemplateId: 'some-other-template' });

    txTemplateUpdateMany = jest.fn().mockResolvedValue({ count: 1 });
    txTemplateCreate = jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'tpl-forked', ...data }));
    txMerchantUpdateMany = jest.fn().mockResolvedValue({ count: 0 });

    transactionFn = jest.fn().mockImplementation((cb) =>
      cb({
        template: { updateMany: txTemplateUpdateMany, create: txTemplateCreate },
        merchant: { updateMany: txMerchantUpdateMany },
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
      await service.list();

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
      const result = await service.list();
      expect(result).toEqual([LIBRARY_TEMPLATE, MERCHANT_OWNED_TEMPLATE]);
    });
  });

  describe('findOne', () => {
    it('queries by id within the same merchant/library scope, not restricted to isHead', async () => {
      await service.findOne('seed-template-receipt');

      expect(templateFindFirst).toHaveBeenCalledWith({
        where: {
          id: 'seed-template-receipt',
          OR: [{ merchantId: 'seed-merchant-demo' }, { merchantId: null }],
          archivedAt: null,
        },
      });
    });

    it('returns the template when found', async () => {
      const result = await service.findOne('seed-template-receipt');
      expect(result).toEqual(LIBRARY_TEMPLATE);
    });

    it('throws NotFoundException when the template is missing or out of scope', async () => {
      templateFindFirst.mockResolvedValue(null);
      await expect(service.findOne('unknown')).rejects.toThrow(NotFoundException);
    });
  });

  describe('save (C-2 fork-on-write)', () => {
    beforeEach(() => {
      templateFindFirst.mockResolvedValue(PARENT_TEMPLATE);
    });

    it('creates exactly one new row with parentTemplateId/version/isHead set from the parent', async () => {
      const result = await service.save(PARENT_TEMPLATE.id, VALID_BODY);

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
      await service.save(PARENT_TEMPLATE.id, VALID_BODY);

      const createCall = txTemplateCreate.mock.calls[0][0];
      expect(createCall.data.layoutSchema).toEqual({
        schemaVersion: 2,
        skeleton: PARENT_TEMPLATE.skeleton,
        blocks: VALID_BODY.layoutSchema.blocks,
      });
    });

    it('flips the parent isHead to false without archiving it, by default', async () => {
      await service.save(PARENT_TEMPLATE.id, VALID_BODY);

      expect(txTemplateUpdateMany).toHaveBeenCalledWith({
        where: { id: PARENT_TEMPLATE.id, isHead: true },
        data: { isHead: false },
      });
    });

    it('archivePrevious: true sets archivedAt on the same parent-flip statement', async () => {
      await service.save(PARENT_TEMPLATE.id, { ...VALID_BODY, archivePrevious: true });

      expect(txTemplateUpdateMany).toHaveBeenCalledWith({
        where: { id: PARENT_TEMPLATE.id, isHead: true },
        data: { isHead: false, archivedAt: expect.any(Date) },
      });
    });

    it('repoints Merchant.defaultTemplateId unconditionally by where-clause match (no separate read)', async () => {
      await service.save(PARENT_TEMPLATE.id, VALID_BODY);

      expect(txMerchantUpdateMany).toHaveBeenCalledWith({
        where: { id: PARENT_TEMPLATE.merchantId, defaultTemplateId: PARENT_TEMPLATE.id },
        data: { defaultTemplateId: 'tpl-forked' },
      });
    });

    it('rejects a malformed layoutSchema.blocks before opening a transaction — zero writes', async () => {
      await expect(service.save(PARENT_TEMPLATE.id, { layoutSchema: { blocks: 'not-an-array' as never } })).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(transactionFn).not.toHaveBeenCalled();
    });

    it('rejects a non-boolean archivePrevious before opening a transaction — zero writes', async () => {
      await expect(service.save(PARENT_TEMPLATE.id, { ...VALID_BODY, archivePrevious: 'yes' as never })).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(transactionFn).not.toHaveBeenCalled();
    });

    it('rejects a document failing T-6 validation before opening a transaction — zero writes', async () => {
      const noHeader: SaveTemplateBody = {
        layoutSchema: { blocks: [{ id: 'blk_1', type: 'ITEMS', order: 1, props: {}, visible: true, width: 'full' }] },
      };
      await expect(service.save(PARENT_TEMPLATE.id, noHeader)).rejects.toThrow(UnprocessableEntityException);
      expect(transactionFn).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the target template does not exist or is out of scope', async () => {
      templateFindFirst.mockResolvedValue(null);
      await expect(service.save('unknown', VALID_BODY)).rejects.toThrow(NotFoundException);
      expect(transactionFn).not.toHaveBeenCalled();
    });

    it('refuses to fork a library preset (merchantId: null) — zero writes', async () => {
      templateFindFirst.mockResolvedValue({ ...PARENT_TEMPLATE, merchantId: null });
      await expect(service.save(PARENT_TEMPLATE.id, VALID_BODY)).rejects.toThrow(UnprocessableEntityException);
      expect(transactionFn).not.toHaveBeenCalled();
    });

    it('refuses to fork a non-head (stale) version — zero writes', async () => {
      templateFindFirst.mockResolvedValue({ ...PARENT_TEMPLATE, isHead: false });
      await expect(service.save(PARENT_TEMPLATE.id, VALID_BODY)).rejects.toThrow(UnprocessableEntityException);
      expect(transactionFn).not.toHaveBeenCalled();
    });

    it('aborts with ConflictException when isHead already flipped concurrently — no row created', async () => {
      txTemplateUpdateMany.mockResolvedValue({ count: 0 });

      await expect(service.save(PARENT_TEMPLATE.id, VALID_BODY)).rejects.toThrow(ConflictException);
      expect(txTemplateCreate).not.toHaveBeenCalled();
      expect(txMerchantUpdateMany).not.toHaveBeenCalled();
    });
  });

  describe('clone (C-3)', () => {
    it('deep-copies a library preset into a fresh, independent lineage', async () => {
      templateFindFirst.mockResolvedValue(LIBRARY_TEMPLATE);
      const result = await service.clone(LIBRARY_TEMPLATE.id);

      expect(templateCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          merchantId: 'seed-merchant-demo',
          version: 1,
          parentTemplateId: null,
          isHead: true,
        }),
      });
      expect(result.id).toBe('tpl-cloned');
    });

    it('throws NotFoundException when the preset is missing or out of scope', async () => {
      templateFindFirst.mockResolvedValue(null);
      await expect(service.clone('unknown')).rejects.toThrow(NotFoundException);
      expect(templateCreate).not.toHaveBeenCalled();
    });

    it('refuses to clone a merchant-owned template', async () => {
      templateFindFirst.mockResolvedValue(MERCHANT_OWNED_TEMPLATE);
      await expect(service.clone(MERCHANT_OWNED_TEMPLATE.id)).rejects.toThrow(UnprocessableEntityException);
      expect(templateCreate).not.toHaveBeenCalled();
    });
  });

  describe('setDefault (C-3)', () => {
    it('repoints Merchant.defaultTemplateId at the given head template', async () => {
      templateFindFirst.mockResolvedValue(MERCHANT_OWNED_TEMPLATE);
      await service.setDefault(MERCHANT_OWNED_TEMPLATE.id);

      expect(merchantUpdate).toHaveBeenCalledWith({
        where: { id: 'seed-merchant-demo' },
        data: { defaultTemplateId: MERCHANT_OWNED_TEMPLATE.id },
      });
    });

    it('throws NotFoundException when the template is missing or out of scope', async () => {
      templateFindFirst.mockResolvedValue(null);
      await expect(service.setDefault('unknown')).rejects.toThrow(NotFoundException);
      expect(merchantUpdate).not.toHaveBeenCalled();
    });

    it('refuses to set a non-head version as default', async () => {
      templateFindFirst.mockResolvedValue({ ...MERCHANT_OWNED_TEMPLATE, isHead: false });
      await expect(service.setDefault(MERCHANT_OWNED_TEMPLATE.id)).rejects.toThrow(UnprocessableEntityException);
      expect(merchantUpdate).not.toHaveBeenCalled();
    });
  });

  describe('archive (C-3)', () => {
    it('sets archivedAt on a merchant-owned head template that is not the current default', async () => {
      templateFindFirst.mockResolvedValue(MERCHANT_OWNED_TEMPLATE);
      merchantFindUnique.mockResolvedValue({ id: 'seed-merchant-demo', defaultTemplateId: 'some-other-template' });

      const result = await service.archive(MERCHANT_OWNED_TEMPLATE.id);

      expect(templateUpdate).toHaveBeenCalledWith({
        where: { id: MERCHANT_OWNED_TEMPLATE.id },
        data: { archivedAt: expect.any(Date) },
      });
      expect(result.archivedAt).toBeInstanceOf(Date);
    });

    it('refuses to archive the current default, naming the reason, zero writes', async () => {
      templateFindFirst.mockResolvedValue(MERCHANT_OWNED_TEMPLATE);
      merchantFindUnique.mockResolvedValue({ id: 'seed-merchant-demo', defaultTemplateId: MERCHANT_OWNED_TEMPLATE.id });

      await expect(service.archive(MERCHANT_OWNED_TEMPLATE.id)).rejects.toThrow(UnprocessableEntityException);
      expect(templateUpdate).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the template is missing, out of scope, or already archived', async () => {
      templateFindFirst.mockResolvedValue(null);
      await expect(service.archive('unknown')).rejects.toThrow(NotFoundException);
      expect(templateUpdate).not.toHaveBeenCalled();
    });

    it('refuses to archive a non-head version', async () => {
      templateFindFirst.mockResolvedValue({ ...MERCHANT_OWNED_TEMPLATE, isHead: false });
      await expect(service.archive(MERCHANT_OWNED_TEMPLATE.id)).rejects.toThrow(UnprocessableEntityException);
      expect(templateUpdate).not.toHaveBeenCalled();
    });
  });
});
