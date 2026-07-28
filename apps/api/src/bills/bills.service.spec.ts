import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BillsService } from './bills.service';
import { CreateBillDto } from './dto/create-bill.dto';

const MERCHANT_A = {
  id: 'merchant_A',
  name: 'Demo Merchant',
  gstin: '27ABCDE1234F1Z5',
  gstStateCode: '27',
  defaultChannel: 'EMAIL',
  addressLine1: '221, Linking Road',
  addressLine2: null,
  city: 'Mumbai',
  pincode: '400050',
  state: 'Maharashtra',
};
const MERCHANT_B_ID = 'merchant_B';

const SHARED_TAX_TEMPLATE = {
  id: 'tpl-shared-tax',
  merchantId: null,
  billType: 'TAX_INVOICE',
  createdAt: new Date('2026-01-01T00:00:00Z'),
};

const CREATED_ORDER = {
  id: 'order-1',
  bill: { id: 'bill-1', templateId: SHARED_TAX_TEMPLATE.id },
  link: { identifier: 'abcdefghij' },
};

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
    orderUpsert = jest.fn().mockResolvedValue(CREATED_ORDER);
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

  it('D-13 fallback: an unresolvable template_id falls back to the shared TAX_COMPLIANT template, deterministically ordered', async () => {
    templateFindFirst
      .mockResolvedValueOnce(null) // the requested (unknown) template_id doesn't resolve
      .mockResolvedValueOnce(null) // no merchant-specific TAX_INVOICE template
      .mockResolvedValueOnce(SHARED_TAX_TEMPLATE); // falls back to the shared one

    const dto = validDto({ template_id: 'does-not-exist' });
    const result = await service.createBill(dto, MERCHANT_A.id);

    expect(result.body.template_id_used).toBe(SHARED_TAX_TEMPLATE.id);
    expect(templateFindFirst).toHaveBeenNthCalledWith(2, expect.objectContaining({ orderBy: { createdAt: 'asc' } }));
    expect(templateFindFirst).toHaveBeenNthCalledWith(3, expect.objectContaining({ orderBy: { createdAt: 'asc' } }));
  });
});
