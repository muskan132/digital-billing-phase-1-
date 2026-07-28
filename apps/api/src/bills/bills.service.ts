import { ForbiddenException, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBillDto } from './dto/create-bill.dto';
import { InvoiceLineInput, InvoiceResult } from './invoice-calc';
import { CalcMismatch, SuppliedTotals, validateCalculation } from './calc-validate';
import { GstFieldMissing, GstValidationInput, validateGstFields } from './gst-validate';
import { maskEmail, maskMobile } from '../common/mask.util';

@Injectable()
export class BillsService {
  private readonly logger = new Logger(BillsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // merchantId is the guard-resolved, trusted identity (ApiKeyGuard/A-1). Every step
  // below uses it, never dto.merchant_id — that field is read exactly once, for the
  // BR-15 equality check, and discarded.
  async createBill(dto: CreateBillDto, merchantId: string) {
    if (dto.merchant_id && dto.merchant_id !== merchantId) {
      throw new ForbiddenException('merchant_id does not match the authenticated API key');
    }

    if (!dto.line_items || dto.line_items.length === 0) {
      throw new UnprocessableEntityException({
        error_code: 'LINE_ITEMS_REQUIRED',
        message: 'line_items must contain at least one item',
      });
    }

    const merchant = await this.prisma.merchant.findUnique({ where: { id: merchantId } });
    if (!merchant) {
      // merchantId came from a resolved, ACTIVE MerchantApiKey row with an FK to Merchant
      // — this is a referential-integrity violation, not a caller error.
      throw new Error(`Merchant ${merchantId} not found despite an active API key`);
    }

    this.logger.log(
      `POST /v1/bills merchantId=${merchantId} externalTransactionId=${dto.external_transaction_id} ` +
        `mobile=${maskMobile(dto.contact?.mobile)} email=${maskEmail(dto.contact?.email)}`,
    );

    const gstInput: GstValidationInput = {
      invoiceNumber: dto.invoice_number,
      currency: dto.currency,
      placeOfSupply: dto.place_of_supply,
      lineItems: dto.line_items.map((li) => ({ hsn: li.hsn, uom: li.uom })),
      taxBlock: {
        cgstPaise: BigInt(dto.tax_block.cgst_paise || '0'),
        sgstPaise: BigInt(dto.tax_block.sgst_paise || '0'),
        igstPaise: BigInt(dto.tax_block.igst_paise || '0'),
      },
    };

    try {
      validateGstFields(gstInput, { gstin: merchant.gstin, gstStateCode: merchant.gstStateCode });
    } catch (err) {
      if (err instanceof GstFieldMissing) {
        throw new UnprocessableEntityException({ error_code: 'GST_FIELD_MISSING', field: err.field });
      }
      throw err;
    }

    const lines: InvoiceLineInput[] = dto.line_items.map((li) => ({
      lineNo: li.line_no,
      quantity: li.quantity,
      unitPricePaise: BigInt(li.unit_price_paise),
      itemDiscountPaise: BigInt(li.item_discount_paise || '0'),
      taxRateBp: li.tax_rate_bp,
    }));

    const supplied: SuppliedTotals = {
      subtotalPaise: BigInt(dto.totals.subtotal_paise),
      discountPaise: BigInt(dto.totals.discount_paise),
      taxPaise: BigInt(dto.totals.tax_paise),
      cgstPaise: BigInt(dto.tax_block.cgst_paise),
      sgstPaise: BigInt(dto.tax_block.sgst_paise),
      igstPaise: BigInt(dto.tax_block.igst_paise),
      totalPaise: BigInt(dto.totals.total_paise),
      lines: dto.line_items.map((li) => ({
        lineNo: li.line_no,
        taxPaise: BigInt(li.tax_paise),
        cgstPaise: BigInt(li.cgst_paise),
        sgstPaise: BigInt(li.sgst_paise),
        igstPaise: BigInt(li.igst_paise),
      })),
    };

    let result: InvoiceResult;
    try {
      result = validateCalculation(
        lines,
        BigInt(dto.totals.bill_discount_paise || '0'),
        dto.place_of_supply,
        merchant.gstStateCode ?? '',
        supplied,
      );
    } catch (err) {
      if (err instanceof CalcMismatch) {
        throw new UnprocessableEntityException({
          error_code: 'CALC_MISMATCH',
          field: err.field,
          expected: err.expected,
          supplied: err.supplied,
        });
      }
      throw err;
    }

    return this.toResponse(result);
  }

  private toResponse(result: InvoiceResult) {
    return {
      lines: result.lines.map((l) => ({
        line_no: l.lineNo,
        gross_paise: l.grossPaise.toString(),
        after_item_discount_paise: l.afterItemDiscountPaise.toString(),
        bill_discount_alloc_paise: l.billDiscountAllocPaise.toString(),
        taxable_value_paise: l.taxableValuePaise.toString(),
        tax_rate_bp: l.taxRateBp,
        tax_paise: l.taxPaise.toString(),
        cgst_paise: l.cgstPaise.toString(),
        sgst_paise: l.sgstPaise.toString(),
        igst_paise: l.igstPaise.toString(),
      })),
      subtotal_paise: result.subtotalPaise.toString(),
      discount_paise: result.discountPaise.toString(),
      tax_paise: result.taxPaise.toString(),
      cgst_paise: result.cgstPaise.toString(),
      sgst_paise: result.sgstPaise.toString(),
      igst_paise: result.igstPaise.toString(),
      total_paise: result.totalPaise.toString(),
    };
  }
}
