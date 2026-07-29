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
        invoiceNumber: null,
        subtotalPaise: null,
        discountPaise: null,
        taxPaise: null,
        cgstPaise: null,
        sgstPaise: null,
        igstPaise: null,
        placeOfSupply: null,
        merchantGstin: null,
        layoutSnapshot: {
          schemaVersion: 1,
          skeleton: 'MINIMALIST',
          blocks: [{ type: 'HEADER', order: 1, props: {} }],
          templateId: 'seed-template-receipt',
          templateVersion: 1,
        },
      },
      items: [],
    },
  };
}

function makeTaxInvoiceLinkRow() {
  return {
    identifier: 'tAxInv0ic3',
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
        billType: 'TAX_INVOICE',
        totalPaise: 26900n,
        currency: 'INR',
        snapshot: { merchantName: 'Demo Merchant', invoiceNumber: 'INV-2026-0001' },
        invoiceNumber: 'INV-2026-0001',
        subtotalPaise: 25000n,
        discountPaise: 0n,
        taxPaise: 1900n,
        cgstPaise: 950n,
        sgstPaise: 950n,
        igstPaise: 0n,
        placeOfSupply: '27',
        merchantGstin: '27ABCDE1234F1Z5',
        layoutSnapshot: {
          schemaVersion: 1,
          skeleton: 'TAX_COMPLIANT',
          blocks: [{ type: 'HEADER', order: 1, props: {} }],
          templateId: 'seed-template-tax-invoice',
          templateVersion: 1,
        },
      },
      items: [
        {
          lineNo: 1,
          name: 'Wireless Mouse',
          hsn: '8471',
          uom: 'NOS',
          quantity: 2,
          unitPricePaise: 10000n,
          itemDiscountPaise: 0n,
          billDiscountAllocPaise: 0n,
          taxRateBp: 500,
          taxableValuePaise: 20000n,
          taxPaise: 1000n,
          cgstPaise: 500n,
          sgstPaise: 500n,
          igstPaise: 0n,
        },
        {
          lineNo: 2,
          name: 'USB-C Cable',
          hsn: '8544',
          uom: 'NOS',
          quantity: 1,
          unitPricePaise: 5000n,
          itemDiscountPaise: 0n,
          billDiscountAllocPaise: 0n,
          taxRateBp: 1800,
          taxableValuePaise: 5000n,
          taxPaise: 900n,
          cgstPaise: 450n,
          sgstPaise: 450n,
          igstPaise: 0n,
        },
      ],
    },
  };
}

const ALLOWED_BILL_KEYS = [
  'billType',
  'totalPaise',
  'currency',
  'snapshot',
  'invoiceNumber',
  'subtotalPaise',
  'discountPaise',
  'taxPaise',
  'cgstPaise',
  'sgstPaise',
  'igstPaise',
  'placeOfSupply',
  'merchantGstin',
  'items',
  'layoutSnapshot',
].sort();

const ALLOWED_ITEM_KEYS = [
  'lineNo',
  'name',
  'hsn',
  'uom',
  'quantity',
  'unitPricePaise',
  'itemDiscountPaise',
  'billDiscountAllocPaise',
  'taxRateBp',
  'taxableValuePaise',
  'taxPaise',
  'cgstPaise',
  'sgstPaise',
  'igstPaise',
].sort();

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

  it('includes layoutSnapshot.skeleton so the renderer can pick a style', async () => {
    const findUnique = jest.fn().mockResolvedValue(makeLinkRow());
    const prisma = { link: { findUnique } } as unknown as PrismaService;
    const service = new LinksService(prisma);

    const result = await service.resolve('aBc123XYZ0');

    expect((result.bill.layoutSnapshot as { skeleton: string }).skeleton).toBe('MINIMALIST');
  });

  // TEMPLATE_SYSTEM_v2 §7: the live `template` relation must never be selected for
  // layout purposes again — that join is exactly the bug §7 fixes. A structural check,
  // not just "the DTO happens not to show it": the query itself must never ask for it.
  it('never selects the live template relation — layout comes from layoutSnapshot only', async () => {
    const findUnique = jest.fn().mockResolvedValue(makeLinkRow());
    const prisma = { link: { findUnique } } as unknown as PrismaService;
    const service = new LinksService(prisma);

    await service.resolve('aBc123XYZ0');

    const billSelect = findUnique.mock.calls[0][0].select.order.select.bill.select;
    expect(billSelect).not.toHaveProperty('template');
    expect(billSelect).toHaveProperty('layoutSnapshot', true);
  });

  // A receipt identifier must still resolve exactly as it did before L-3: the new v2
  // fields are present but null/empty, nothing else about the RECEIPT shape changes.
  it('a RECEIPT identifier still resolves unchanged — new v2 fields null, items empty', async () => {
    const findUnique = jest.fn().mockResolvedValue(makeLinkRow());
    const prisma = { link: { findUnique } } as unknown as PrismaService;
    const service = new LinksService(prisma);

    const result = await service.resolve('aBc123XYZ0');

    expect(result.bill).toEqual({
      billType: 'RECEIPT',
      totalPaise: '100',
      currency: 'INR',
      snapshot: { merchantName: 'Demo Merchant', amountPaise: '100', currency: 'INR' },
      invoiceNumber: null,
      subtotalPaise: null,
      discountPaise: null,
      taxPaise: null,
      cgstPaise: null,
      sgstPaise: null,
      igstPaise: null,
      placeOfSupply: null,
      merchantGstin: null,
      items: [],
      layoutSnapshot: {
        schemaVersion: 1,
        skeleton: 'MINIMALIST',
        blocks: [{ type: 'HEADER', order: 1, props: {} }],
        templateId: 'seed-template-receipt',
        templateVersion: 1,
      },
    });
  });

  it('a TAX_INVOICE identifier resolves with populated GST fields and mapped/stringified items[]', async () => {
    const findUnique = jest.fn().mockResolvedValue(makeTaxInvoiceLinkRow());
    const prisma = { link: { findUnique } } as unknown as PrismaService;
    const service = new LinksService(prisma);

    const result = await service.resolve('tAxInv0ic3');

    expect(result.bill).toMatchObject({
      invoiceNumber: 'INV-2026-0001',
      subtotalPaise: '25000',
      discountPaise: '0',
      taxPaise: '1900',
      cgstPaise: '950',
      sgstPaise: '950',
      igstPaise: '0',
      placeOfSupply: '27',
      merchantGstin: '27ABCDE1234F1Z5',
    });
    expect(result.bill.items).toEqual([
      {
        lineNo: 1,
        name: 'Wireless Mouse',
        hsn: '8471',
        uom: 'NOS',
        quantity: 2,
        unitPricePaise: '10000',
        itemDiscountPaise: '0',
        billDiscountAllocPaise: '0',
        taxRateBp: 500,
        taxableValuePaise: '20000',
        taxPaise: '1000',
        cgstPaise: '500',
        sgstPaise: '500',
        igstPaise: '0',
      },
      {
        lineNo: 2,
        name: 'USB-C Cable',
        hsn: '8544',
        uom: 'NOS',
        quantity: 1,
        unitPricePaise: '5000',
        itemDiscountPaise: '0',
        billDiscountAllocPaise: '0',
        taxRateBp: 1800,
        taxableValuePaise: '5000',
        taxPaise: '900',
        cgstPaise: '450',
        sgstPaise: '450',
        igstPaise: '0',
      },
    ]);
  });

  // D-28: the key-set enforcement test — exact allowed keys, top level AND the nested
  // items[] member shape. A denylist sample (checking a few known-bad fields) is not
  // a whitelist; this asserts the complete set, so an accidental future addition to
  // the select (e.g. a new internal column) fails this test even if nobody remembers
  // to add it to a denylist.
  it('D-28 key-set: result.bill and each result.bill.items[] member expose exactly the allowed keys', async () => {
    const findUnique = jest.fn().mockResolvedValue(makeTaxInvoiceLinkRow());
    const prisma = { link: { findUnique } } as unknown as PrismaService;
    const service = new LinksService(prisma);

    const result = await service.resolve('tAxInv0ic3');

    expect(Object.keys(result.bill).sort()).toEqual(ALLOWED_BILL_KEYS);
    expect(result.bill.items.length).toBeGreaterThan(0);
    for (const item of result.bill.items) {
      expect(Object.keys(item).sort()).toEqual(ALLOWED_ITEM_KEYS);
    }
  });

  // L-2's core safety guarantee, extended for L-3: adding GST/invoice fields and
  // items[] must never widen the select to touch customer PII, secrets, or
  // internal/audit-only columns — at any nesting level.
  it('never includes customer PII, rawCallback, secrets, or internal IDs — including inside items[]', async () => {
    const findUnique = jest.fn().mockResolvedValue(makeTaxInvoiceLinkRow());
    const prisma = { link: { findUnique } } as unknown as PrismaService;
    const service = new LinksService(prisma);

    const result = await service.resolve('tAxInv0ic3');
    const serialized = JSON.stringify(result);

    expect(serialized).not.toContain('customerMobile_pii');
    expect(serialized).not.toContain('customerEmail_pii');
    expect(serialized).not.toContain('rawCallback');
    expect(serialized).not.toContain('secureHash');
    expect(serialized).not.toContain('secretKeyEnc');
    expect(serialized).not.toContain('keyHash');

    // Assert the Prisma `select` itself never asks for these fields, regardless of
    // what a (mocked) row happens to contain.
    const selectArg = findUnique.mock.calls[0][0].select;
    const orderSelect = selectArg.order.select;
    const merchantSelect = orderSelect.merchant.select;
    const itemsSelect = orderSelect.items.select;

    expect(merchantSelect).not.toHaveProperty('secretKeyEnc');
    expect(orderSelect).not.toHaveProperty('customerMobile_pii');
    expect(orderSelect).not.toHaveProperty('customerEmail_pii');
    expect(orderSelect).not.toHaveProperty('rawCallback');
    expect(orderSelect).not.toHaveProperty('id');
    expect(itemsSelect).not.toHaveProperty('id');
    expect(itemsSelect).not.toHaveProperty('orderId');
    expect(itemsSelect).not.toHaveProperty('createdAt');
  });

  it('throws NotFoundException for an unknown identifier', async () => {
    const findUnique = jest.fn().mockResolvedValue(null);
    const prisma = { link: { findUnique } } as unknown as PrismaService;
    const service = new LinksService(prisma);

    await expect(service.resolve('nOtFound00')).rejects.toThrow('Unknown identifier');
  });
});
