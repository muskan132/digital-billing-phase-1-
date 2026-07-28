import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IDENTIFIER_PATTERN } from '../common/link-id.util';

export interface BillViewLineItem {
  lineNo: number;
  name: string;
  hsn: string;
  uom: string;
  quantity: number;
  unitPricePaise: string;
  itemDiscountPaise: string;
  billDiscountAllocPaise: string;
  taxRateBp: number;
  taxableValuePaise: string;
  taxPaise: string;
  cgstPaise: string;
  sgstPaise: string;
  igstPaise: string;
}

export interface BillViewDto {
  identifier: string;
  merchant: {
    name: string;
    addressLine1: string | null;
    addressLine2: string | null;
    city: string | null;
    state: string | null;
    pincode: string | null;
    gstin: string | null;
    supportEmail: string | null;
    supportPhone: string | null;
  };
  bill: {
    billType: string;
    totalPaise: string;
    currency: string;
    snapshot: unknown;
    // v2 (L-3, D-28): null for RECEIPT bills, populated for TAX_INVOICE.
    invoiceNumber: string | null;
    subtotalPaise: string | null;
    discountPaise: string | null;
    taxPaise: string | null;
    cgstPaise: string | null;
    sgstPaise: string | null;
    igstPaise: string | null;
    placeOfSupply: string | null;
    merchantGstin: string | null;
    items: BillViewLineItem[];
    template: {
      name: string;
      billType: string;
      layoutSchema: unknown;
      skeleton: string;
    };
  };
}

@Injectable()
export class LinksService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(identifier: string): Promise<BillViewDto> {
    if (!IDENTIFIER_PATTERN.test(identifier)) {
      throw new NotFoundException('Unknown identifier');
    }

    // bill.snapshot is a JSON column — Prisma's `select` whitelists top-level fields
    // only, it cannot filter what's inside a JSON blob. L-2's PII-safety guarantee
    // therefore depends on P-1 (callbacks.service.ts) only ever writing non-PII
    // values into Bill.snapshot. If what P-1 writes into snapshot ever changes,
    // this file's safety assumption needs re-checking.
    const link = await this.prisma.link.findUnique({
      where: { identifier },
      select: {
        identifier: true,
        order: {
          select: {
            merchant: {
              // Merchant business details — the equivalent of what's printed on any
              // shop receipt (address/GSTIN/support contact), not customer PII. Safe
              // for this public unauth page. Explicit field list, no wildcard select —
              // do not widen this to include anything else on Merchant.
              select: {
                name: true,
                addressLine1: true,
                addressLine2: true,
                city: true,
                state: true,
                pincode: true,
                gstin: true,
                supportEmail: true,
                supportPhone: true,
              },
            },
            // No status check here: P-1 only ever reaches the `link: { create }`
            // nested-write branch inside the SUCCESS upsert — every other exit path
            // (NON_SUCCESS, missing txnId, D-15 unparseable amount, D-14a missing
            // template) returns before a Link is created. A Link row existing is
            // itself proof the Order is SUCCESS with a Bill.
            bill: {
              select: {
                billType: true,
                totalPaise: true,
                currency: true,
                snapshot: true,
                // v2 (L-3, D-28): TAX_INVOICE GST/invoice fields. Explicit field list —
                // do not widen this to a wildcard select.
                invoiceNumber: true,
                subtotalPaise: true,
                discountPaise: true,
                taxPaise: true,
                cgstPaise: true,
                sgstPaise: true,
                igstPaise: true,
                placeOfSupply: true,
                merchantGstin: true,
                template: {
                  select: {
                    name: true,
                    billType: true,
                    layoutSchema: true,
                    skeleton: true, // layout enum only, not data — safe to whitelist
                  },
                },
              },
            },
            // v2 (L-3, D-28): line items, whitelisted to exactly the D-28 items[]
            // member shape — id/orderId/createdAt are internal/audit-only and must
            // never be selected here.
            items: {
              select: {
                lineNo: true,
                name: true,
                hsn: true,
                uom: true,
                quantity: true,
                unitPricePaise: true,
                itemDiscountPaise: true,
                billDiscountAllocPaise: true,
                taxRateBp: true,
                taxableValuePaise: true,
                taxPaise: true,
                cgstPaise: true,
                sgstPaise: true,
                igstPaise: true,
              },
              orderBy: { lineNo: 'asc' },
            },
          },
        },
      },
    });

    if (!link || !link.order.bill) {
      throw new NotFoundException('Unknown identifier');
    }

    const { bill } = link.order;

    return {
      identifier: link.identifier,
      merchant: {
        name: link.order.merchant.name,
        addressLine1: link.order.merchant.addressLine1,
        addressLine2: link.order.merchant.addressLine2,
        city: link.order.merchant.city,
        state: link.order.merchant.state,
        pincode: link.order.merchant.pincode,
        gstin: link.order.merchant.gstin,
        supportEmail: link.order.merchant.supportEmail,
        supportPhone: link.order.merchant.supportPhone,
      },
      bill: {
        billType: bill.billType,
        totalPaise: bill.totalPaise.toString(),
        currency: bill.currency,
        snapshot: bill.snapshot,
        invoiceNumber: bill.invoiceNumber,
        subtotalPaise: bill.subtotalPaise?.toString() ?? null,
        discountPaise: bill.discountPaise?.toString() ?? null,
        taxPaise: bill.taxPaise?.toString() ?? null,
        cgstPaise: bill.cgstPaise?.toString() ?? null,
        sgstPaise: bill.sgstPaise?.toString() ?? null,
        igstPaise: bill.igstPaise?.toString() ?? null,
        placeOfSupply: bill.placeOfSupply,
        merchantGstin: bill.merchantGstin,
        items: link.order.items.map((item) => ({
          lineNo: item.lineNo,
          name: item.name,
          hsn: item.hsn,
          uom: item.uom,
          quantity: item.quantity,
          unitPricePaise: item.unitPricePaise.toString(),
          itemDiscountPaise: item.itemDiscountPaise.toString(),
          billDiscountAllocPaise: item.billDiscountAllocPaise.toString(),
          taxRateBp: item.taxRateBp,
          taxableValuePaise: item.taxableValuePaise.toString(),
          taxPaise: item.taxPaise.toString(),
          cgstPaise: item.cgstPaise.toString(),
          sgstPaise: item.sgstPaise.toString(),
          igstPaise: item.igstPaise.toString(),
        })),
        template: bill.template,
      },
    };
  }
}
