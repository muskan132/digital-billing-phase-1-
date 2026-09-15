import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BillsService } from './bills.service';
import { CreateBillDto } from './dto/create-bill.dto';

const SHARED_TAX_TEMPLATE = {
  id: 'tpl-shared-tax',
  merchantId: null,
  billType: 'TAX_INVOICE',
  skeleton: 'TAX_COMPLIANT',
  // D-96: the real shape since T-5's migration — a v2 envelope, not a bare array.
  layoutSchema: { schemaVersion: 2, skeleton: 'TAX_COMPLIANT', blocks: [{ type: 'HEADER', order: 1, props: {} }] },
  version: 1,
  archivedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const MERCHANT_A = {
  id: 'merchant_A',
  name: 'Demo Merchant',
  gstin: '27ABCDE1234F1Z5',
  gstStateCode: '27',
  defaultChannel: 'EMAIL',
  // F-7 (D-77): POST /v1/bills resolves this pointer now, not a positional chain.
  defaultTaxInvoiceTemplateId: SHARED_TAX_TEMPLATE.id,
  addressLine1: '221, Linking Road',
  addressLine2: null,
  city: 'Mumbai',
  pincode: '400050',
  state: 'Maharashtra',
};
const MERCHANT_B_ID = 'merchant_B';

function validDto(overrides: Partial<CreateBillDto> = {}): CreateBillDto {
  return {
    external_transaction_id: 'ext-1',
    invoice_number: 'INV-1',
    place_of_supply: '27',
    currency: 'INR',
    sale_at: '2026-07-27T10:00:00Z',
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
    totals: {
      subtotal_paise: '100',
      bill_discount_paise: '0',
      discount_paise: '0',
      tax_paise: '7',
      total_paise: '107',
    },
    tax_block: { cgst_paise: '4', sgst_paise: '3', igst_paise: '0' },
    ...overrides,
  };
}

describe('BillsService.createBill', () => {
  let orderFindUnique: jest.Mock;
  let orderUpsert: jest.Mock;
  let merchantFindUnique: jest.Mock;
  let templateFindFirst: jest.Mock;
  let service: BillsService;

  beforeAll(() => {
    process.env.PUBLIC_BILL_BASE_URL = 'http://localhost:3000';
  });

  beforeEach(() => {
    orderFindUnique = jest.fn().mockResolvedValue(null); // no replay by default
    // Echo the resolved templateId the service put on the nested Bill create, so
    // `template_id_used` in the response reflects real resolution (F-7).
    orderUpsert = jest.fn().mockImplementation((args: { create?: { bill?: { create?: { templateId?: string } } } }) =>
      Promise.resolve({
        id: 'order-1',
        bill: { id: 'bill-1', templateId: args.create?.bill?.create?.templateId ?? SHARED_TAX_TEMPLATE.id },
        link: { identifier: 'abcdefghij' },
      }),
    );
    merchantFindUnique = jest.fn().mockResolvedValue(MERCHANT_A);
    templateFindFirst = jest.fn().mockResolvedValue(SHARED_TAX_TEMPLATE);

    const prisma = {
      order: { findUnique: orderFindUnique, upsert: orderUpsert },
      merchant: { findUnique: merchantFindUnique },
      template: { findFirst: templateFindFirst },
    } as unknown as PrismaService;
    service = new BillsService(prisma);
  });

  it('persists exactly one Order upsert with nested OrderItem[]/Bill/Link/Broadcast and returns created:true, 201-shape body', async () => {
    const dto = validDto({ contact: { email: 'jane@example.com' } });

    const result = await service.createBill(dto, MERCHANT_A.id);

    expect(result.created).toBe(true);
    expect(result.body).toEqual({
      bill_id: 'bill-1',
      identifier: 'abcdefghij',
      url: 'http://localhost:3000/abcdefghij',
      template_id_used: SHARED_TAX_TEMPLATE.id,
    });

    expect(orderUpsert).toHaveBeenCalledTimes(1);
    const call = orderUpsert.mock.calls[0][0];
    expect(call.where).toEqual({ externalTransactionId: 'ext-1' });
    expect(call.update).toEqual({});
    expect(call.create.source).toBe('DIRECT_API');
    expect(call.create.status).toBe('SUCCESS');
    expect(call.create.items.create).toHaveLength(1);
    expect(call.create.bill.create.billType).toBe('TAX_INVOICE');
    expect(call.create.link.create.identifier).toEqual(expect.any(String));
    expect(call.create.broadcasts.create).toEqual([
      { channel: 'EMAIL', recipient: 'jane@example.com', status: 'PENDING' },
    ]);
  });

  // TEMPLATE_SYSTEM_v2 §7: the resolved template's render spec must be frozen onto
  // the bill at creation, independent of the live Template row afterward.
  it('freezes the resolved template render spec into Bill.layoutSnapshot at creation', async () => {
    const dto = validDto();
    await service.createBill(dto, MERCHANT_A.id);

    const call = orderUpsert.mock.calls[0][0];
    const layoutSnapshot = call.create.bill.create.layoutSnapshot;
    // D-96 regression check: .blocks must be the plain array extracted from
    // the v2 envelope, never the whole envelope object.
    expect(Array.isArray(layoutSnapshot.blocks)).toBe(true);
    expect(layoutSnapshot).toEqual({
      schemaVersion: 1,
      skeleton: SHARED_TAX_TEMPLATE.skeleton,
      blocks: SHARED_TAX_TEMPLATE.layoutSchema.blocks,
      templateId: SHARED_TAX_TEMPLATE.id,
      templateVersion: SHARED_TAX_TEMPLATE.version,
    });
  });

  it('D-12: omits the Broadcast relation entirely when no contact is supplied, but still creates Bill/Link', async () => {
    const dto = validDto(); // no contact
    await service.createBill(dto, MERCHANT_A.id);

    const call = orderUpsert.mock.calls[0][0];
    expect(call.create.broadcasts).toBeUndefined();
    expect(call.create.bill).toBeDefined();
    expect(call.create.link).toBeDefined();
  });

  it('replay of the same external_transaction_id returns created:false, 200-shape body, and performs no write', async () => {
    orderFindUnique.mockResolvedValue({
      id: 'order-1',
      bill: { id: 'bill-1', templateId: SHARED_TAX_TEMPLATE.id },
      link: { identifier: 'abcdefghij' },
    });

    const result = await service.createBill(validDto(), MERCHANT_A.id);

    expect(result.created).toBe(false);
    expect(result.body.bill_id).toBe('bill-1');
    expect(orderUpsert).not.toHaveBeenCalled();
    expect(merchantFindUnique).not.toHaveBeenCalled(); // replay short-circuits before merchant lookup too
  });

  it('replay does not re-validate — a payload that would otherwise fail M-3/G-1 still replays cleanly', async () => {
    orderFindUnique.mockResolvedValue({
      id: 'order-1',
      bill: { id: 'bill-1', templateId: SHARED_TAX_TEMPLATE.id },
      link: { identifier: 'abcdefghij' },
    });
    const dto = validDto({ line_items: [] }); // would be LINE_ITEMS_REQUIRED on a fresh call

    const result = await service.createBill(dto, MERCHANT_A.id);
    expect(result.created).toBe(false);
  });

  it('rejects a duplicate invoice_number for the same merchant with 422 DUPLICATE_INVOICE_NUMBER', async () => {
    orderUpsert.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { target: ['merchantId', 'invoiceNumber'] },
      }),
    );

    await expect(service.createBill(validDto(), MERCHANT_A.id)).rejects.toMatchObject({
      response: { error_code: 'DUPLICATE_INVOICE_NUMBER', field: 'invoice_number' },
    });
  });

  it('does NOT relabel an unrelated P2002 (e.g. externalTransactionId race) as DUPLICATE_INVOICE_NUMBER', async () => {
    const raceErr = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target: ['externalTransactionId'] },
    });
    orderUpsert.mockRejectedValue(raceErr);

    await expect(service.createBill(validDto(), MERCHANT_A.id)).rejects.toBe(raceErr);
  });

  it('a 422 from G-1 leaves the Order upsert uncalled (zero writes)', async () => {
    const dto = validDto();
    dto.line_items[0].hsn = undefined;

    await expect(service.createBill(dto, MERCHANT_A.id)).rejects.toMatchObject({
      response: { error_code: 'GST_FIELD_MISSING' },
    });
    expect(orderUpsert).not.toHaveBeenCalled();
  });

  it('a 422 from M-3 leaves the Order upsert uncalled (zero writes)', async () => {
    const dto = validDto();
    dto.totals.total_paise = '108';

    await expect(service.createBill(dto, MERCHANT_A.id)).rejects.toMatchObject({
      response: { error_code: 'CALC_MISMATCH' },
    });
    expect(orderUpsert).not.toHaveBeenCalled();
  });

  it('rejects empty line_items with 422 LINE_ITEMS_REQUIRED and no write', async () => {
    await expect(service.createBill(validDto({ line_items: [] }), MERCHANT_A.id)).rejects.toMatchObject({
      response: { error_code: 'LINE_ITEMS_REQUIRED' },
    });
    expect(orderUpsert).not.toHaveBeenCalled();
  });

  it('rejects a body.merchant_id naming a different merchant than the authenticated key, with 403, before any DB work', async () => {
    const dto = validDto({ merchant_id: MERCHANT_B_ID });

    await expect(service.createBill(dto, MERCHANT_A.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(orderFindUnique).not.toHaveBeenCalled();
    expect(orderUpsert).not.toHaveBeenCalled();
  });

  it('logs the request with contact masked, never raw', async () => {
    const logSpy = jest.spyOn((service as unknown as { logger: { log: jest.Mock } }).logger, 'log');
    const dto = validDto({ contact: { mobile: '9876543210', email: 'jane@example.com' } });

    await service.createBill(dto, MERCHANT_A.id);

    const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain('9876543210');
    expect(logged).not.toContain('jane@example.com');
    expect(logged).toContain('j***@example.com');
  });

  it('ignores a bill_type field on the payload — never honoured, billType is always forced to TAX_INVOICE', async () => {
    const dto = { ...validDto(), bill_type: 'RECEIPT' } as CreateBillDto & { bill_type: string };
    await service.createBill(dto, MERCHANT_A.id);

    const call = orderUpsert.mock.calls[0][0];
    expect(call.create.bill.create.billType).toBe('TAX_INVOICE');
  });

  // ---- F-7 (D-61 / D-77): direct-API template resolution contract ----------
  describe('resolveTaxInvoiceTemplate (F-7 / D-61 / D-77)', () => {
    it('no template_id → uses Merchant.defaultTaxInvoiceTemplateId, no template_fallback in the body', async () => {
      templateFindFirst.mockResolvedValue(SHARED_TAX_TEMPLATE);
      const result = await service.createBill(validDto(), MERCHANT_A.id);

      expect(result.body.template_id_used).toBe(SHARED_TAX_TEMPLATE.id);
      expect(result.body).not.toHaveProperty('template_fallback');
      // resolved by id, not by a createdAt-ordered scan.
      expect(templateFindFirst).toHaveBeenCalledWith({
        where: { id: SHARED_TAX_TEMPLATE.id, OR: [{ merchantId: MERCHANT_A.id }, { merchantId: null }] },
      });
      expect(templateFindFirst).not.toHaveBeenCalledWith(expect.objectContaining({ orderBy: expect.anything() }));
    });

    it('own visible TAX_INVOICE template_id → used as-is, no template_fallback', async () => {
      const ownTemplate = { ...SHARED_TAX_TEMPLATE, id: 'tpl-own-tax', merchantId: MERCHANT_A.id };
      templateFindFirst.mockResolvedValueOnce(ownTemplate);
      const result = await service.createBill(validDto({ template_id: 'tpl-own-tax' }), MERCHANT_A.id);

      expect(result.body.template_id_used).toBe('tpl-own-tax');
      expect(result.body).not.toHaveProperty('template_fallback');
      // D-77: the caller-supplied lookup is scoped + archivedAt-filtered, NO billType filter.
      expect(templateFindFirst).toHaveBeenNthCalledWith(1, {
        where: { id: 'tpl-own-tax', archivedAt: null, OR: [{ merchantId: MERCHANT_A.id }, { merchantId: null }] },
      });
    });

    it('an UNKNOWN template_id → 201, falls back to the default, template_fallback stated in the body', async () => {
      templateFindFirst
        .mockResolvedValueOnce(null) // the supplied id resolves to nothing
        .mockResolvedValueOnce(SHARED_TAX_TEMPLATE); // the default pointer
      const result = await service.createBill(validDto({ template_id: 'does-not-exist' }), MERCHANT_A.id);

      expect(result.created).toBe(true);
      expect(result.body.template_id_used).toBe(SHARED_TAX_TEMPLATE.id);
      expect(result.body.template_fallback).toEqual({
        reason: 'TEMPLATE_ID_NOT_FOUND',
        requested_template_id: 'does-not-exist',
      });
      // no positional scan anywhere
      expect(templateFindFirst).not.toHaveBeenCalledWith(expect.objectContaining({ orderBy: expect.anything() }));
    });

    it("another merchant's template_id → the SAME fallback (findFirst is scoped, returns null), never a 403, never their template", async () => {
      // scoped lookup excludes merchant B's row → null, identical to "unknown"
      templateFindFirst.mockResolvedValueOnce(null).mockResolvedValueOnce(SHARED_TAX_TEMPLATE);
      const result = await service.createBill(validDto({ template_id: 'tpl-belongs-to-B' }), MERCHANT_A.id);

      expect(result.created).toBe(true);
      expect(result.body.template_id_used).toBe(SHARED_TAX_TEMPLATE.id);
      expect(result.body.template_id_used).not.toBe('tpl-belongs-to-B');
      expect(result.body.template_fallback).toEqual({
        reason: 'TEMPLATE_ID_NOT_FOUND',
        requested_template_id: 'tpl-belongs-to-B',
      });
    });

    it('a visible RECEIPT template_id → 422 TEMPLATE_BILL_TYPE_MISMATCH, Order upsert never called (zero writes)', async () => {
      templateFindFirst.mockResolvedValueOnce({ ...SHARED_TAX_TEMPLATE, id: 'tpl-receipt', billType: 'RECEIPT' });

      await expect(service.createBill(validDto({ template_id: 'tpl-receipt' }), MERCHANT_A.id)).rejects.toMatchObject({
        response: { error_code: 'TEMPLATE_BILL_TYPE_MISMATCH' },
      });
      expect(orderUpsert).not.toHaveBeenCalled();
    });

    it('null defaultTaxInvoiceTemplateId + no template_id → 422 NO_DEFAULT_TAX_INVOICE_TEMPLATE, zero writes', async () => {
      merchantFindUnique.mockResolvedValue({ ...MERCHANT_A, defaultTaxInvoiceTemplateId: null });

      await expect(service.createBill(validDto(), MERCHANT_A.id)).rejects.toMatchObject({
        response: { error_code: 'NO_DEFAULT_TAX_INVOICE_TEMPLATE' },
      });
      expect(orderUpsert).not.toHaveBeenCalled();
    });

    it('null defaultTaxInvoiceTemplateId + an unknown template_id → still 422 NO_DEFAULT_TAX_INVOICE_TEMPLATE, zero writes', async () => {
      merchantFindUnique.mockResolvedValue({ ...MERCHANT_A, defaultTaxInvoiceTemplateId: null });
      templateFindFirst.mockResolvedValueOnce(null); // supplied id resolves to nothing

      await expect(
        service.createBill(validDto({ template_id: 'does-not-exist' }), MERCHANT_A.id),
      ).rejects.toMatchObject({ response: { error_code: 'NO_DEFAULT_TAX_INVOICE_TEMPLATE' } });
      expect(orderUpsert).not.toHaveBeenCalled();
    });

    it('D-27 replay: template resolution never runs on a repeated external_transaction_id', async () => {
      orderFindUnique.mockResolvedValue({
        id: 'order-1',
        bill: { id: 'bill-1', templateId: SHARED_TAX_TEMPLATE.id },
        link: { identifier: 'abcdefghij' },
      });
      const resolveSpy = jest.spyOn(
        service as unknown as { resolveTaxInvoiceTemplate: () => unknown },
        'resolveTaxInvoiceTemplate',
      );

      const result = await service.createBill(validDto({ template_id: 'anything' }), MERCHANT_A.id);

      expect(result.created).toBe(false);
      expect(result.body).not.toHaveProperty('template_fallback');
      expect(resolveSpy).not.toHaveBeenCalled();
      expect(templateFindFirst).not.toHaveBeenCalled();
    });
  });
});
