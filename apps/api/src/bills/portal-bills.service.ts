// H-1 / D-46 / D-48 / D-58: GET /portal/bills — merchant-scoped, keyset-
// paginated history. Separate from BillsService (the write path, D-27
// replay/G-1/M-3 concerns) — this is read-only and has nothing to do with
// bill creation.
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BillType, BroadcastStatus, Channel, OrderSource, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { maskBroadcastRecipient, maskEmailPortal, maskMobilePortal } from '../common/portal-contact-mask.util';
import { decodeCursor, encodeCursor } from './portal-bills-cursor.util';

export const PORTAL_BILLS_DEFAULT_LIMIT = 20;
export const PORTAL_BILLS_MAX_LIMIT = 100;

export interface PortalBillListItemDto {
  id: string;
  createdAt: string;
  billType: BillType;
  source: OrderSource;
  invoiceNumber: string | null;
  totalPaise: string;
  currency: string;
  customerMobileMasked: string | null;
  customerEmailMasked: string | null;
}

export interface PortalBillListResult {
  items: PortalBillListItemDto[];
  nextCursor: string | null;
}

export interface PortalBillListFilters {
  dateFrom?: Date;
  dateTo?: Date;
  billType?: BillType;
  source?: OrderSource;
}

export interface PortalBillListParams {
  filters: PortalBillListFilters;
  cursor?: string;
  limit?: number;
}

// D-48's whitelist, enforced at this one construction site (the writer) —
// the ONLY place a Bill+Order row is turned into what the client sees.
// Never spread a raw Prisma row into the response.
function toDto(row: {
  id: string;
  createdAt: Date;
  billType: BillType;
  invoiceNumber: string | null;
  totalPaise: bigint;
  currency: string;
  order: { source: OrderSource; customerMobile_pii: string | null; customerEmail_pii: string | null };
}): PortalBillListItemDto {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    billType: row.billType,
    source: row.order.source,
    invoiceNumber: row.invoiceNumber,
    totalPaise: row.totalPaise.toString(),
    currency: row.currency,
    customerMobileMasked: maskMobilePortal(row.order.customerMobile_pii),
    customerEmailMasked: maskEmailPortal(row.order.customerEmail_pii),
  };
}

// H-3 / D-48: the full-detail DTO. `customerMobile`/`customerEmail` are
// deliberately NOT named `customerMobile_pii`/`customerEmail_pii` even
// though D-48's text uses those names literally — no other DTO in this
// codebase puts the `_pii` DB-column suffix on a wire field, and this one
// doesn't either; the source columns are still exactly what D-48 names.
export interface PortalBillDetailLineItemDto {
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

export interface PortalBillBroadcastDto {
  channel: Channel;
  status: BroadcastStatus;
  attempts: number;
  sentAt: string | null;
  recipientMasked: string | null;
}

export interface PortalBillDetailDto {
  id: string;
  createdAt: string;
  billType: BillType;
  source: OrderSource;
  invoiceNumber: string | null;
  totalPaise: string;
  currency: string;
  subtotalPaise: string | null;
  discountPaise: string | null;
  taxPaise: string | null;
  cgstPaise: string | null;
  sgstPaise: string | null;
  igstPaise: string | null;
  placeOfSupply: string | null;
  merchantGstin: string | null;
  items: PortalBillDetailLineItemDto[];
  // The public bill page's identifier — null on the rare row where the
  // Link relation is absent at the schema level, even though the write
  // paths always create Bill+Link together in practice.
  identifier: string | null;
  customerMobile: string | null;
  customerEmail: string | null;
  broadcasts: PortalBillBroadcastDto[];
}

// D-48's detail whitelist, enforced at this one construction site — the
// ONLY place a Bill+Order row is turned into what the client sees. Never
// spread a raw Prisma row into the response. Deliberately excludes
// `snapshot`/`layoutSnapshot` (D-48: "explicitly unchanged") — those are
// render-plumbing internals, not bill facts; `identifier` is how a
// merchant actually sees the rendered bill, via the public page.
function toDetailDto(row: {
  id: string;
  createdAt: Date;
  billType: BillType;
  invoiceNumber: string | null;
  totalPaise: bigint;
  currency: string;
  subtotalPaise: bigint | null;
  discountPaise: bigint | null;
  taxPaise: bigint | null;
  cgstPaise: bigint | null;
  sgstPaise: bigint | null;
  igstPaise: bigint | null;
  placeOfSupply: string | null;
  merchantGstin: string | null;
  order: {
    source: OrderSource;
    customerMobile_pii: string | null;
    customerEmail_pii: string | null;
    link: { identifier: string } | null;
    items: {
      lineNo: number;
      name: string;
      hsn: string;
      uom: string;
      quantity: number;
      unitPricePaise: bigint;
      itemDiscountPaise: bigint;
      billDiscountAllocPaise: bigint;
      taxRateBp: number;
      taxableValuePaise: bigint;
      taxPaise: bigint;
      cgstPaise: bigint;
      sgstPaise: bigint;
      igstPaise: bigint;
    }[];
    broadcasts: { channel: Channel; status: BroadcastStatus; attempts: number; sentAt: Date | null; recipient: string }[];
  };
}): PortalBillDetailDto {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    billType: row.billType,
    source: row.order.source,
    invoiceNumber: row.invoiceNumber,
    totalPaise: row.totalPaise.toString(),
    currency: row.currency,
    subtotalPaise: row.subtotalPaise?.toString() ?? null,
    discountPaise: row.discountPaise?.toString() ?? null,
    taxPaise: row.taxPaise?.toString() ?? null,
    cgstPaise: row.cgstPaise?.toString() ?? null,
    sgstPaise: row.sgstPaise?.toString() ?? null,
    igstPaise: row.igstPaise?.toString() ?? null,
    placeOfSupply: row.placeOfSupply,
    merchantGstin: row.merchantGstin,
    items: row.order.items.map((item) => ({
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
    identifier: row.order.link?.identifier ?? null,
    customerMobile: row.order.customerMobile_pii,
    customerEmail: row.order.customerEmail_pii,
    broadcasts: row.order.broadcasts.map((b) => ({
      channel: b.channel,
      status: b.status,
      attempts: b.attempts,
      sentAt: b.sentAt?.toISOString() ?? null,
      recipientMasked: maskBroadcastRecipient(b.channel, b.recipient),
    })),
  };
}

@Injectable()
export class PortalBillsService {
  constructor(private readonly prisma: PrismaService) {}

  // merchantId is a mandatory argument, never read from the environment or a
  // query param — the caller (PortalBillsController) sources it from
  // MerchantContext (SessionGuard), never from client input (D-46).
  async list(merchantId: string, params: PortalBillListParams): Promise<PortalBillListResult> {
    const limit = params.limit ?? PORTAL_BILLS_DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > PORTAL_BILLS_MAX_LIMIT) {
      throw new BadRequestException(`limit must be an integer between 1 and ${PORTAL_BILLS_MAX_LIMIT}`);
    }

    let cursor: { createdAt: Date; id: string } | undefined;
    if (params.cursor) {
      try {
        cursor = decodeCursor(params.cursor);
      } catch {
        throw new BadRequestException('invalid cursor');
      }
    }

    const { dateFrom, dateTo, billType, source } = params.filters;

    // merchantId sits in the SAME where object as every filter, in the SAME
    // findMany call below — there is no separate unscoped fetch this could
    // fall back to.
    const filterConditions: Prisma.BillWhereInput = {
      merchantId,
      ...(billType ? { billType } : {}),
      ...(dateFrom || dateTo
        ? { createdAt: { ...(dateFrom ? { gte: dateFrom } : {}), ...(dateTo ? { lte: dateTo } : {}) } }
        : {}),
      ...(source ? { order: { source } } : {}),
    };

    // Manual keyset tie-break — not Prisma's native `cursor:` option, which
    // only supports a single unique field and can't express "createdAt < c
    // OR (createdAt = c AND id < c.id)" (D-58).
    const cursorCondition: Prisma.BillWhereInput | undefined = cursor
      ? {
          OR: [
            { createdAt: { lt: cursor.createdAt } },
            { AND: [{ createdAt: cursor.createdAt }, { id: { lt: cursor.id } }] },
          ],
        }
      : undefined;

    const where: Prisma.BillWhereInput = cursorCondition ? { AND: [filterConditions, cursorCondition] } : filterConditions;

    // take limit+1: the extra row (dropped below) is how we know there's a
    // next page without a separate COUNT query.
    const rows = await this.prisma.bill.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
      select: {
        id: true,
        createdAt: true,
        billType: true,
        invoiceNumber: true,
        totalPaise: true,
        currency: true,
        order: { select: { source: true, customerMobile_pii: true, customerEmail_pii: true } },
      },
    });

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = pageRows[pageRows.length - 1];

    return {
      items: pageRows.map(toDto),
      nextCursor: hasMore && lastRow ? encodeCursor({ createdAt: lastRow.createdAt, id: lastRow.id }) : null,
    };
  }

  // H-3 / D-47: `id` AND `merchantId` in the SAME findFirst — another
  // merchant's billId and a genuinely nonexistent one both hit this exact
  // same query and both come back null, so both throw the exact same 404.
  // No separate ownership check that could distinguish the two.
  async findOne(merchantId: string, id: string): Promise<PortalBillDetailDto> {
    const bill = await this.prisma.bill.findFirst({
      where: { id, merchantId },
      select: {
        id: true,
        createdAt: true,
        billType: true,
        invoiceNumber: true,
        totalPaise: true,
        currency: true,
        subtotalPaise: true,
        discountPaise: true,
        taxPaise: true,
        cgstPaise: true,
        sgstPaise: true,
        igstPaise: true,
        placeOfSupply: true,
        merchantGstin: true,
        order: {
          select: {
            source: true,
            customerMobile_pii: true,
            customerEmail_pii: true,
            link: { select: { identifier: true } },
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
            broadcasts: { select: { channel: true, status: true, attempts: true, sentAt: true, recipient: true } },
          },
        },
      },
    });

    if (!bill) {
      throw new NotFoundException();
    }

    return toDetailDto(bill);
  }
}
