import { ForbiddenException, Injectable, Logger, UnprocessableEntityException } from '@nestjs/common';
import { Prisma, Template } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateBillDto } from './dto/create-bill.dto';
import { InvoiceLineInput, InvoiceResult } from './invoice-calc';
import { CalcMismatch, SuppliedTotals, validateCalculation } from './calc-validate';
import { GstFieldMissing, GstValidationInput, validateGstFields } from './gst-validate';
import { maskEmail, maskMobile } from '../common/mask.util';
import { generateIdentifier } from '../common/link-id.util';
import { hashSnapshot } from '../common/layout-snapshot-hash.util';

// F-7 (D-61 / D-77): stated in the response ONLY when the caller supplied a
// template_id that did not resolve (unknown or another merchant's) and the
// bill fell back to Merchant.defaultTaxInvoiceTemplateId. Absent — not null —
// on every other path (own template used as-is, or no template_id supplied).
export interface TemplateFallback {
  reason: 'TEMPLATE_ID_NOT_FOUND';
  requested_template_id: string;
}

export interface CreateBillResult {
  created: boolean;
  body: {
    bill_id: string;
    identifier: string;
    url: string;
    template_id_used: string;
    template_fallback?: TemplateFallback;
  };
}

@Injectable()
export class BillsService {
  private readonly logger = new Logger(BillsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // merchantId is the guard-resolved, trusted identity (ApiKeyGuard/A-1). Every step
  // below uses it, never dto.merchant_id — that field is read exactly once, for the
  // BR-15 equality check, and discarded.
  async createBill(dto: CreateBillDto, merchantId: string): Promise<CreateBillResult> {
    if (dto.merchant_id && dto.merchant_id !== merchantId) {
      throw new ForbiddenException('merchant_id does not match the authenticated API key');
    }

    // D-27: a replay of the same external_transaction_id returns the existing bill,
    // unchanged — no re-validation, no re-write, regardless of what the replay body
    // says. Checked before line_items/G-1/M-3 so a replay never re-runs any of it.
    const existing = await this.prisma.order.findUnique({
      where: { externalTransactionId: dto.external_transaction_id },
      include: { bill: true, link: true },
    });
    if (existing) {
      if (!existing.bill || !existing.link) {
        throw new Error(
          `Order ${existing.id} (externalTransactionId=${dto.external_transaction_id}) is missing its ` +
            `Bill/Link — unreachable for a DIRECT_API SUCCESS order`,
        );
      }
      return { created: false, body: this.toResponseBody(existing.bill, existing.link) };
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

    const { template, fallback } = await this.resolveTaxInvoiceTemplate(
      merchantId,
      merchant.defaultTaxInvoiceTemplateId,
      dto.template_id,
    );

    const dtoLineByNo = new Map(dto.line_items.map((li) => [li.line_no, li]));
    const orderItemsData = result.lines.map((l) => {
      const li = dtoLineByNo.get(l.lineNo);
      if (!li) {
        // Unreachable: result.lines is derived 1:1 from dto.line_items by computeInvoice.
        throw new Error(`No supplied line_items entry for computed lineNo=${l.lineNo}`);
      }
      return {
        lineNo: l.lineNo,
        name: li.name,
        hsn: li.hsn as string, // G-1 already required this to be present
        uom: li.uom as string,
        quantity: li.quantity,
        unitPricePaise: BigInt(li.unit_price_paise),
        itemDiscountPaise: BigInt(li.item_discount_paise || '0'),
        billDiscountAllocPaise: l.billDiscountAllocPaise,
        taxRateBp: l.taxRateBp,
        taxableValuePaise: l.taxableValuePaise,
        taxPaise: l.taxPaise,
        cgstPaise: l.cgstPaise,
        sgstPaise: l.sgstPaise,
        igstPaise: l.igstPaise,
      };
    });

    // D-28: whitelisted TAX_INVOICE snapshot fields only. No customer PII — merchant/
    // transaction facts only, individually checked non-PII per D-28's own reasoning.
    const snapshot = {
      merchantName: merchant.name,
      currency: dto.currency,
      amountPaise: result.totalPaise.toString(),
      invoiceNumber: dto.invoice_number,
      placeOfSupply: dto.place_of_supply,
      merchantGstin: merchant.gstin,
      merchantState: merchant.state,
      merchantAddress:
        [merchant.addressLine1, merchant.addressLine2, merchant.city, merchant.pincode].filter(Boolean).join(', ') ||
        null,
      subtotalPaise: result.subtotalPaise.toString(),
      discountPaise: result.discountPaise.toString(),
      taxPaise: result.taxPaise.toString(),
      cgstPaise: result.cgstPaise.toString(),
      sgstPaise: result.sgstPaise.toString(),
      igstPaise: result.igstPaise.toString(),
      items: orderItemsData.map((oi) => ({
        lineNo: oi.lineNo,
        name: oi.name,
        hsn: oi.hsn,
        uom: oi.uom,
        quantity: oi.quantity,
        unitPricePaise: oi.unitPricePaise.toString(),
        itemDiscountPaise: oi.itemDiscountPaise.toString(),
        billDiscountAllocPaise: oi.billDiscountAllocPaise.toString(),
        taxRateBp: oi.taxRateBp,
        taxableValuePaise: oi.taxableValuePaise.toString(),
        taxPaise: oi.taxPaise.toString(),
        cgstPaise: oi.cgstPaise.toString(),
        sgstPaise: oi.sgstPaise.toString(),
        igstPaise: oi.igstPaise.toString(),
      })),
    };

    // D-12: Order/Bill/Link creation never depends on a recipient being available.
    const recipient = merchant.defaultChannel === 'EMAIL' ? dto.contact?.email : dto.contact?.mobile;

    const layoutSnapshot = {
      schemaVersion: 1,
      skeleton: template.skeleton,
      blocks: template.layoutSchema as Prisma.InputJsonValue,
      templateId: template.id,
      templateVersion: template.version,
    };

    let order;
    try {
      order = await this.prisma.order.upsert({
        where: { externalTransactionId: dto.external_transaction_id },
        create: {
          merchantId,
          source: 'DIRECT_API',
          externalTransactionId: dto.external_transaction_id,
          saleAt: new Date(dto.sale_at),
          amountPaise: result.totalPaise,
          currency: dto.currency,
          status: 'SUCCESS',
          customerMobile_pii: dto.contact?.mobile,
          customerEmail_pii: dto.contact?.email,
          rawCallback: dto as unknown as Prisma.InputJsonValue,
          items: { create: orderItemsData },
          bill: {
            create: {
              merchantId,
              billType: 'TAX_INVOICE',
              templateId: template.id,
              totalPaise: result.totalPaise,
              currency: dto.currency,
              invoiceNumber: dto.invoice_number,
              subtotalPaise: result.subtotalPaise,
              discountPaise: result.discountPaise,
              taxPaise: result.taxPaise,
              cgstPaise: result.cgstPaise,
              sgstPaise: result.sgstPaise,
              igstPaise: result.igstPaise,
              placeOfSupply: dto.place_of_supply,
              merchantGstin: merchant.gstin,
              snapshot,
              // TEMPLATE_SYSTEM_v2 §7: freeze the resolved template's render spec onto
              // the bill at creation. The renderer must read only this, never the live
              // template — editing a template must never change how an issued bill renders.
              layoutSnapshot,
              // Q-4 / D-95: self-certifying hash, written once alongside layoutSnapshot.
              layoutSnapshotHash: hashSnapshot(layoutSnapshot),
            },
          },
          link: { create: { identifier: generateIdentifier() } },
          ...(recipient
            ? { broadcasts: { create: [{ channel: merchant.defaultChannel, recipient, status: 'PENDING' }] } }
            : {}),
        },
        update: {},
        include: { bill: true, link: true },
      });
    } catch (err) {
      if (this.isInvoiceNumberConflict(err)) {
        throw new UnprocessableEntityException({ error_code: 'DUPLICATE_INVOICE_NUMBER', field: 'invoice_number' });
      }
      throw err;
    }

    return { created: true, body: this.toResponseBody(order.bill!, order.link!, fallback) };
  }

  // F-7 (D-61 / D-77): POST /v1/bills template resolution. Supersedes D-13's
  // "no per-order override" — an override is now part of the contract.
  //
  //  - A caller-supplied template_id is used only if it resolves to a VISIBLE
  //    (own or shared library, non-archived) template. The lookup deliberately
  //    does NOT filter on billType — an id that resolves to the wrong type must
  //    be distinguishable from one that resolves to nothing.
  //      * resolves, billType === TAX_INVOICE -> use it, no fallback marker.
  //      * resolves, billType !== TAX_INVOICE -> 422 TEMPLATE_BILL_TYPE_MISMATCH,
  //        thrown here, BEFORE any write (the upsert is further down createBill).
  //      * does not resolve (unknown / another merchant's — D-47: never
  //        distinguished, never a 403/404) -> fall back to the default pointer
  //        AND state the fallback in the response.
  //  - No template_id at all -> use the default pointer, no fallback marker
  //    (this is the base path, not a fallback — D-13 lineage).
  //  - Merchant.defaultTaxInvoiceTemplateId genuinely null -> 422
  //    NO_DEFAULT_TAX_INVOICE_TEMPLATE, no write. No silent last-resort.
  //
  // The positional fallback chain (a scan ordered by row age) is gone entirely (D-61).
  private async resolveTaxInvoiceTemplate(
    merchantId: string,
    defaultTaxInvoiceTemplateId: string | null,
    templateId: string | undefined,
  ): Promise<{ template: Template; fallback: TemplateFallback | null }> {
    if (templateId) {
      // D-77: archivedAt: null — an archived template is not "visible" (D-61).
      const requested = await this.prisma.template.findFirst({
        where: { id: templateId, archivedAt: null, OR: [{ merchantId }, { merchantId: null }] },
      });
      if (requested) {
        if (requested.billType !== 'TAX_INVOICE') {
          throw new UnprocessableEntityException({
            error_code: 'TEMPLATE_BILL_TYPE_MISMATCH',
            message: `Template ${templateId} is a ${requested.billType} template; POST /v1/bills issues TAX_INVOICE bills only.`,
          });
        }
        return { template: requested, fallback: null };
      }
      // Fell through: unknown or not-yours. Fall back to the default, and say so.
    }

    if (!defaultTaxInvoiceTemplateId) {
      throw new UnprocessableEntityException({
        error_code: 'NO_DEFAULT_TAX_INVOICE_TEMPLATE',
        message:
          'This merchant has no default tax-invoice template set. Set one in the portal before issuing tax invoices.',
      });
    }

    const dflt = await this.prisma.template.findFirst({
      where: { id: defaultTaxInvoiceTemplateId, OR: [{ merchantId }, { merchantId: null }] },
    });
    // D-77 / MINOR-2: setDefault (D-76), archive (D-33/D-76) and deleteLineage
    // (D-64) together guarantee this pointer only ever holds a live, non-archived
    // TAX_INVOICE head. A violation is a data-integrity bug, not a caller error.
    if (!dflt) {
      throw new Error(
        `Merchant ${merchantId} defaultTaxInvoiceTemplateId=${defaultTaxInvoiceTemplateId} resolves to no visible template`,
      );
    }
    if (dflt.billType !== 'TAX_INVOICE') {
      throw new Error(
        `Merchant ${merchantId} defaultTaxInvoiceTemplateId=${defaultTaxInvoiceTemplateId} is a ${dflt.billType} template`,
      );
    }

    return {
      template: dflt,
      fallback: templateId ? { reason: 'TEMPLATE_ID_NOT_FOUND', requested_template_id: templateId } : null,
    };
  }

  // Matches P2002 only when the violated constraint names both merchantId and
  // invoiceNumber (Bill_merchantId_invoiceNumber_key) — not any other unique
  // constraint that could theoretically P2002 out of this same write (e.g.
  // Order.externalTransactionId under a race with the replay check above, which this
  // must NOT relabel as a duplicate invoice number).
  private isInvoiceNumberConflict(err: unknown): boolean {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
      return false;
    }
    const target = err.meta?.target;
    const fields = Array.isArray(target) ? target.map(String) : typeof target === 'string' ? [target] : [];
    const joined = fields.join('|');
    return /merchantId/i.test(joined) && /invoiceNumber/i.test(joined);
  }

  // F-7 (D-77): `fallback` is threaded in only from the create path. A replay
  // (200) calls this with no fallback arg, so the replayed body carries no
  // `template_fallback` even if the original 201 did — the marker is a
  // diagnostic of the creation act, not persisted (D-77, accepted asymmetry).
  private toResponseBody(
    bill: { id: string; templateId: string },
    link: { identifier: string },
    fallback?: TemplateFallback | null,
  ): CreateBillResult['body'] {
    return {
      bill_id: bill.id,
      identifier: link.identifier,
      url: `${process.env.PUBLIC_BILL_BASE_URL ?? 'http://localhost:3000'}/${link.identifier}`,
      template_id_used: bill.templateId,
      ...(fallback ? { template_fallback: fallback } : {}),
    };
  }
}
