// H-1 / D-46 / D-48 / D-58: GET /portal/bills — merchant-scoped, keyset-
// paginated history. Separate from BillsService (the write path, D-27
// replay/G-1/M-3 concerns) — this is read-only and has nothing to do with
// bill creation.
import { BadRequestException, Injectable } from '@nestjs/common';
import { BillType, OrderSource, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { maskEmailPortal, maskMobilePortal } from '../common/portal-contact-mask.util';
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
}
