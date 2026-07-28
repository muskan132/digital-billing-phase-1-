import { ForbiddenException, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BillsService } from './bills.service';
import { CreateBillDto } from './dto/create-bill.dto';

const MERCHANT_A = { id: 'merchant_A', gstin: '27ABCDE1234F1Z5', gstStateCode: '27' };
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
  let findUnique: jest.Mock;
  let service: BillsService;

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue(MERCHANT_A);
    const prisma = { merchant: { findUnique } } as unknown as PrismaService;
    service = new BillsService(prisma);
  });

  it('accepts a valid payload and echoes the computed figures with 200-shape body', async () => {
    const result = await service.createBill(validDto(), MERCHANT_A.id);
    expect(result.total_paise).toBe('107');
    expect(result.tax_paise).toBe('7');
    expect(result.lines[0].cgst_paise).toBe('4');
    expect(result.lines[0].sgst_paise).toBe('3');
  });

  it('rejects empty line_items with 422 LINE_ITEMS_REQUIRED', async () => {
    await expect(service.createBill(validDto({ line_items: [] }), MERCHANT_A.id)).rejects.toMatchObject({
      response: { error_code: 'LINE_ITEMS_REQUIRED' },
    });
  });

  it('rejects missing line_items with 422 LINE_ITEMS_REQUIRED', async () => {
    const dto = validDto();
    delete (dto as { line_items?: unknown }).line_items;
    await expect(service.createBill(dto, MERCHANT_A.id)).rejects.toMatchObject({
      response: { error_code: 'LINE_ITEMS_REQUIRED' },
    });
  });

  it('ignores a bill_type field on the payload — it is not part of the DTO and is never honoured', async () => {
    const dto = { ...validDto(), bill_type: 'RECEIPT' } as CreateBillDto & { bill_type: string };
    const result = await service.createBill(dto, MERCHANT_A.id);
    expect(result.total_paise).toBe('107'); // identical to the plain valid-payload result
  });

  it('logs the request with contact masked, never raw', async () => {
    const logSpy = jest.spyOn((service as unknown as { logger: { log: jest.Mock } }).logger, 'log');
    const dto = validDto({ contact: { mobile: '9876543210', email: 'jane@example.com' } });

    await service.createBill(dto, MERCHANT_A.id);

    const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain('9876543210');
    expect(logged).not.toContain('jane@example.com');
    expect(logged).toContain('jane@example.com'.replace(/^[^@]+/, (m) => m[0] + '*'.repeat(m.length - 1)));
  });

  it('rejects a GST_FIELD_MISSING case (e.g. missing HSN) as 422', async () => {
    const dto = validDto();
    dto.line_items[0].hsn = undefined;
    await expect(service.createBill(dto, MERCHANT_A.id)).rejects.toMatchObject({
      response: { error_code: 'GST_FIELD_MISSING', field: 'line_items[0].hsn' },
    });
  });

  it('rejects a CALC_MISMATCH case (total off by one paise) as 422', async () => {
    const dto = validDto();
    dto.totals.total_paise = '108';
    await expect(service.createBill(dto, MERCHANT_A.id)).rejects.toMatchObject({
      response: { error_code: 'CALC_MISMATCH', field: 'totalPaise' },
    });
  });

  it('rejects a body.merchant_id naming a different merchant than the authenticated key, with 403 — and does no downstream work', async () => {
    const dto = validDto({ merchant_id: MERCHANT_B_ID });

    await expect(service.createBill(dto, MERCHANT_A.id)).rejects.toBeInstanceOf(ForbiddenException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('accepts a body.merchant_id that agrees with the authenticated key', async () => {
    const dto = validDto({ merchant_id: MERCHANT_A.id });
    const result = await service.createBill(dto, MERCHANT_A.id);
    expect(result.total_paise).toBe('107');
  });
});
