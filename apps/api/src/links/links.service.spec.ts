import { LinksService } from './links.service';
import { PrismaService } from '../prisma/prisma.service';

function makeLinkRow() {
  return {
    identifier: 'aBc123XYZ0',
    order: {
      merchant: {
        name: 'Demo Merchant',
        addressLine1: '221, Linking Road',
        addressLine2: 'Bandra West',
        city: 'Mumbai',
        state: 'Maharashtra',
        pincode: '400050',
        gstin: '27ABCDE1234F1Z5',
        supportEmail: 'support@demo-merchant.test',
        supportPhone: '+91 22 4000 1234',
      },
      bill: {
        billType: 'RECEIPT',
        totalPaise: 100n,
        currency: 'INR',
        snapshot: { merchantName: 'Demo Merchant', amountPaise: '100', currency: 'INR' },
        template: { name: 'Minimalist Receipt', billType: 'RECEIPT', layoutSchema: [], skeleton: 'MINIMALIST' },
      },
    },
  };
}

describe('LinksService.resolve', () => {
  it('includes the new merchant profile fields in the resolved payload', async () => {
    const findUnique = jest.fn().mockResolvedValue(makeLinkRow());
    const prisma = { link: { findUnique } } as unknown as PrismaService;
    const service = new LinksService(prisma);

    const result = await service.resolve('aBc123XYZ0');

    expect(result.merchant).toEqual({
      name: 'Demo Merchant',
      addressLine1: '221, Linking Road',
      addressLine2: 'Bandra West',
      city: 'Mumbai',
      state: 'Maharashtra',
      pincode: '400050',
      gstin: '27ABCDE1234F1Z5',
      supportEmail: 'support@demo-merchant.test',
      supportPhone: '+91 22 4000 1234',
    });
  });

  it('includes template.skeleton so the renderer can pick a style', async () => {
    const findUnique = jest.fn().mockResolvedValue(makeLinkRow());
    const prisma = { link: { findUnique } } as unknown as PrismaService;
    const service = new LinksService(prisma);

    const result = await service.resolve('aBc123XYZ0');

    expect(result.bill.template.skeleton).toBe('MINIMALIST');
  });

  // L-2's core safety guarantee: adding merchant business fields must never widen the
  // select to touch customer PII or internal/audit-only columns.
  it('never includes customer PII, rawCallback, secureHash, or internal IDs', async () => {
    const findUnique = jest.fn().mockResolvedValue(makeLinkRow());
    const prisma = { link: { findUnique } } as unknown as PrismaService;
    const service = new LinksService(prisma);

    const result = await service.resolve('aBc123XYZ0');
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('customerMobile_pii');
    expect(serialized).not.toContain('customerEmail_pii');
    expect(serialized).not.toContain('rawCallback');
    expect(serialized).not.toContain('secureHash');

    // Assert the Prisma `select` itself never asks for these fields, regardless of
    // what a (mocked) row happens to contain.
    const selectArg = findUnique.mock.calls[0][0].select;
    const merchantSelect = selectArg.order.select.merchant.select;
    const orderSelect = selectArg.order.select;
    expect(merchantSelect).not.toHaveProperty('secretKeyEnc');
    expect(orderSelect).not.toHaveProperty('customerMobile_pii');
    expect(orderSelect).not.toHaveProperty('customerEmail_pii');
    expect(orderSelect).not.toHaveProperty('rawCallback');
    expect(orderSelect).not.toHaveProperty('id');
  });

  it('throws NotFoundException for an unknown identifier', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const prisma = { link: { findUnique } } as unknown as PrismaService;
    const service = new LinksService(prisma);

    await expect(service.resolve('nOtFound00')).rejects.toThrow('Unknown identifier');
  });
});
