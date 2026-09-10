// F-7 (D-61 / D-77): direct-API template resolution contract — real Postgres.
// The two guarantees a mocked PrismaService cannot prove:
//   1. a wrong-billType template_id -> 422 with ZERO rows across Order, Bill,
//      Link, Broadcast AND OrderItem (a real count(), not a status code).
//   2. another merchant's real template_id -> the same fallback as an unknown
//      id, never a 403, never their template rendered.
// Plus: unknown id -> 201 + template_fallback; null default -> 422; the D-27
// replay path unchanged.
import { UnprocessableEntityException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BillsService } from './bills.service';
import { CreateBillDto } from './dto/create-bill.dto';

const prisma = new PrismaClient();
const service = new BillsService(prisma as unknown as PrismaService);

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `f7-itest-${prefix}-${Date.now()}-${counter}`;
}

const MINIMAL_TAX_LAYOUT = { schemaVersion: 2, skeleton: 'TAX_COMPLIANT', blocks: [] };

interface Scratch {
  merchantId: string;
  ownTaxTemplateId: string;
}

async function createScratchMerchant(withDefault: boolean): Promise<Scratch> {
  const merchantId = uid('merchant');
  const ownTaxTemplateId = uid('tpl-tax');
  await prisma.merchant.create({
    data: {
      id: merchantId,
      jiopayMid: uid('mid'),
      name: `F-7 itest ${merchantId}`,
      secretKeyEnc: Buffer.from('unused'),
      gstin: '27ABCDE1234F1Z5',
      gstStateCode: '27',
      state: 'Maharashtra',
    },
  });
  await prisma.template.create({
    data: { id: ownTaxTemplateId, merchantId, name: uid('OwnTax'), billType: 'TAX_INVOICE', layoutSchema: MINIMAL_TAX_LAYOUT, isHead: true },
  });
  if (withDefault) {
    await prisma.merchant.update({ where: { id: merchantId }, data: { defaultTaxInvoiceTemplateId: ownTaxTemplateId } });
  }
  return { merchantId, ownTaxTemplateId };
}

async function cleanup(merchantId: string): Promise<void> {
  const orders = await prisma.order.findMany({ where: { merchantId }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  await prisma.broadcast.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.link.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.bill.deleteMany({ where: { merchantId } });
  await prisma.order.deleteMany({ where: { merchantId } });
  await prisma.merchant.update({ where: { id: merchantId }, data: { defaultTaxInvoiceTemplateId: null } });
  await prisma.template.deleteMany({ where: { merchantId } });
  await prisma.merchant.deleteMany({ where: { id: merchantId } });
}

function validDto(overrides: Partial<CreateBillDto> = {}): CreateBillDto {
  return {
    external_transaction_id: uid('ext'),
    invoice_number: uid('INV'),
    place_of_supply: '27',
    currency: 'INR',
    sale_at: '2026-09-10T10:00:00Z',
    line_items: [
      {
        line_no: 1,
        name: 'Widget',
        hsn: '1234',
        uom: 'NOS',
        quantity: 1,
        unit_price_paise: '100',
        item_discount_paise: '0',
        tax_rate_bp: 700,
        tax_paise: '7',
        cgst_paise: '4',
        sgst_paise: '3',
        igst_paise: '0',
      },
    ],
    totals: { subtotal_paise: '100', bill_discount_paise: '0', discount_paise: '0', tax_paise: '7', total_paise: '107' },
    tax_block: { cgst_paise: '4', sgst_paise: '3', igst_paise: '0' },
    ...overrides,
  };
}

async function countAll(merchantId: string) {
  const orderIds = (await prisma.order.findMany({ where: { merchantId }, select: { id: true } })).map((o) => o.id);
  return {
    order: await prisma.order.count({ where: { merchantId } }),
    bill: await prisma.bill.count({ where: { merchantId } }),
    link: await prisma.link.count({ where: { orderId: { in: orderIds } } }),
    broadcast: await prisma.broadcast.count({ where: { orderId: { in: orderIds } } }),
    orderItem: await prisma.orderItem.count({ where: { orderId: { in: orderIds } } }),
  };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe('F-7: direct-API template resolution (real DB)', () => {
  it('THE wrong-billType test — a visible RECEIPT template_id → 422 TEMPLATE_BILL_TYPE_MISMATCH, ZERO rows across Order/Bill/Link/Broadcast/OrderItem', async () => {
    const m = await createScratchMerchant(true);
    try {
      const receiptTemplate = await prisma.template.create({
        data: { id: uid('tpl-rcpt'), merchantId: m.merchantId, name: uid('Receipt'), billType: 'RECEIPT', layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] }, isHead: true },
      });

      const before = await countAll(m.merchantId);

      const err = await service.createBill(validDto({ template_id: receiptTemplate.id }), m.merchantId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ error_code: 'TEMPLATE_BILL_TYPE_MISMATCH' });

      const after = await countAll(m.merchantId);
      expect(after).toEqual(before);
      expect(after).toEqual({ order: 0, bill: 0, link: 0, broadcast: 0, orderItem: 0 });
    } finally {
      await cleanup(m.merchantId);
    }
  });

  it("THE cross-merchant test — merchant B's real TAX_INVOICE template_id, as merchant A → same fallback as unknown, never a 403, never B's template rendered", async () => {
    const a = await createScratchMerchant(true);
    const b = await createScratchMerchant(true);
    try {
      const result = await service.createBill(validDto({ template_id: b.ownTaxTemplateId }), a.merchantId);

      expect(result.created).toBe(true);
      expect(result.body.template_id_used).toBe(a.ownTaxTemplateId); // A's default, NOT B's id
      expect(result.body.template_id_used).not.toBe(b.ownTaxTemplateId);
      expect(result.body.template_fallback).toEqual({
        reason: 'TEMPLATE_ID_NOT_FOUND',
        requested_template_id: b.ownTaxTemplateId,
      });

      const bill = await prisma.bill.findUniqueOrThrow({ where: { id: result.body.bill_id }, select: { templateId: true } });
      expect(bill.templateId).toBe(a.ownTaxTemplateId);
      expect(bill.templateId).not.toBe(b.ownTaxTemplateId);
    } finally {
      await cleanup(a.merchantId);
      await cleanup(b.merchantId);
    }
  });

  it('an UNKNOWN template_id → 201, default used, template_fallback stated; Bill.templateId is the default', async () => {
    const m = await createScratchMerchant(true);
    try {
      const result = await service.createBill(validDto({ template_id: 'totally-made-up-id' }), m.merchantId);
      expect(result.created).toBe(true);
      expect(result.body.template_id_used).toBe(m.ownTaxTemplateId);
      expect(result.body.template_fallback).toEqual({ reason: 'TEMPLATE_ID_NOT_FOUND', requested_template_id: 'totally-made-up-id' });
      const bill = await prisma.bill.findUniqueOrThrow({ where: { id: result.body.bill_id }, select: { templateId: true } });
      expect(bill.templateId).toBe(m.ownTaxTemplateId);
    } finally {
      await cleanup(m.merchantId);
    }
  });

  it('no template_id + a set default → 201, default used, NO template_fallback key', async () => {
    const m = await createScratchMerchant(true);
    try {
      const result = await service.createBill(validDto(), m.merchantId);
      expect(result.body.template_id_used).toBe(m.ownTaxTemplateId);
      expect(result.body).not.toHaveProperty('template_fallback');
    } finally {
      await cleanup(m.merchantId);
    }
  });

  it('own visible TAX_INVOICE template_id → used as-is, NO template_fallback', async () => {
    const m = await createScratchMerchant(true);
    try {
      const other = await prisma.template.create({
        data: { id: uid('tpl-tax2'), merchantId: m.merchantId, name: uid('OtherTax'), billType: 'TAX_INVOICE', layoutSchema: MINIMAL_TAX_LAYOUT, isHead: true },
      });
      const result = await service.createBill(validDto({ template_id: other.id }), m.merchantId);
      expect(result.body.template_id_used).toBe(other.id);
      expect(result.body).not.toHaveProperty('template_fallback');
    } finally {
      await cleanup(m.merchantId);
    }
  });

  it('an ARCHIVED TAX_INVOICE template_id → treated as not-visible → falls back to the default (D-77)', async () => {
    const m = await createScratchMerchant(true);
    try {
      const archived = await prisma.template.create({
        data: { id: uid('tpl-arch'), merchantId: m.merchantId, name: uid('Arch'), billType: 'TAX_INVOICE', layoutSchema: MINIMAL_TAX_LAYOUT, isHead: true, archivedAt: new Date() },
      });
      const result = await service.createBill(validDto({ template_id: archived.id }), m.merchantId);
      expect(result.body.template_id_used).toBe(m.ownTaxTemplateId);
      expect(result.body.template_fallback).toEqual({ reason: 'TEMPLATE_ID_NOT_FOUND', requested_template_id: archived.id });
    } finally {
      await cleanup(m.merchantId);
    }
  });

  it('null defaultTaxInvoiceTemplateId → 422 NO_DEFAULT_TAX_INVOICE_TEMPLATE, zero writes', async () => {
    const m = await createScratchMerchant(false); // no default set
    try {
      const before = await countAll(m.merchantId);
      const err = await service.createBill(validDto(), m.merchantId).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect((err as UnprocessableEntityException).getResponse()).toMatchObject({ error_code: 'NO_DEFAULT_TAX_INVOICE_TEMPLATE' });
      expect(await countAll(m.merchantId)).toEqual(before);
    } finally {
      await cleanup(m.merchantId);
    }
  });

  it('D-27 replay: repeated external_transaction_id → 200-shape, same bill, NO new rows, no template_fallback', async () => {
    const m = await createScratchMerchant(true);
    try {
      const dto = validDto({ template_id: 'unknown-on-first-call' });
      const first = await service.createBill(dto, m.merchantId);
      expect(first.created).toBe(true);
      expect(first.body.template_fallback).toBeDefined(); // first call fell back

      const countsAfterFirst = await countAll(m.merchantId);

      const replay = await service.createBill(dto, m.merchantId);
      expect(replay.created).toBe(false);
      expect(replay.body.bill_id).toBe(first.body.bill_id);
      expect(replay.body.template_id_used).toBe(first.body.template_id_used);
      expect(replay.body).not.toHaveProperty('template_fallback'); // D-77 accepted asymmetry
      expect(await countAll(m.merchantId)).toEqual(countsAfterFirst);
    } finally {
      await cleanup(m.merchantId);
    }
  });
});

// F-7 verify line: "the oldest-by-createdAt chain appears nowhere in the file".
describe('F-7: the positional fallback chain is gone from bills.service.ts', () => {
  it('grep-clean: no createdAt-ordered scan, no merchantSpecific/oldest-shared fallback', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    const path = require('path') as typeof import('path');
    const src = fs.readFileSync(path.join(__dirname, 'bills.service.ts'), 'utf8');
    expect(src).not.toMatch(/orderBy:\s*\{\s*createdAt/);
    expect(src).not.toMatch(/merchantSpecific/);
    expect(src).not.toMatch(/oldest/i);
  });
});
