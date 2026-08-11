import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TemplatesService } from './templates.service';

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

describe('TemplatesService', () => {
  let templateFindMany: jest.Mock;
  let templateFindFirst: jest.Mock;
  let service: TemplatesService;

  beforeEach(() => {
    templateFindMany = jest.fn().mockResolvedValue([LIBRARY_TEMPLATE, MERCHANT_OWNED_TEMPLATE]);
    templateFindFirst = jest.fn().mockResolvedValue(LIBRARY_TEMPLATE);

    const prisma = {
      template: { findMany: templateFindMany, findFirst: templateFindFirst },
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
});
