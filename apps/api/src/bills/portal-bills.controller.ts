// H-1: GET /portal/bills. SessionGuard (A-3) resolves MerchantContext and
// re-checks eligibility on every request; @Roles per D-50 — history is
// readable by MERCHANT_ADMIN and STORE_STAFF, same as the roadmap states
// (rbac.md is referenced there but absent from docs/; D-50's own text is
// the source of truth used here).
import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { BillType, OrderSource, UserRole } from '@prisma/client';
import { SessionGuard } from '../auth/session.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentMerchantContext, MerchantContext } from '../auth/merchant-context';
import { PortalBillListResult, PortalBillsService } from './portal-bills.service';

interface ListBillsQuery {
  cursor?: string;
  limit?: string;
  dateFrom?: string;
  dateTo?: string;
  billType?: string;
  source?: string;
}

function parseIsoDate(value: string | undefined, paramName: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${paramName} must be a valid ISO 8601 date`);
  }
  return parsed;
}

function parseBillType(value: string | undefined): BillType | undefined {
  if (value === undefined) return undefined;
  if (!Object.values(BillType).includes(value as BillType)) {
    throw new BadRequestException(`billType must be one of ${Object.values(BillType).join(', ')}`);
  }
  return value as BillType;
}

function parseSource(value: string | undefined): OrderSource | undefined {
  if (value === undefined) return undefined;
  if (!Object.values(OrderSource).includes(value as OrderSource)) {
    throw new BadRequestException(`source must be one of ${Object.values(OrderSource).join(', ')}`);
  }
  return value as OrderSource;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new BadRequestException('limit must be an integer');
  }
  return parsed;
}

@Controller('portal/bills')
@UseGuards(SessionGuard)
@Roles(UserRole.MERCHANT_ADMIN, UserRole.STORE_STAFF)
export class PortalBillsController {
  constructor(private readonly portalBillsService: PortalBillsService) {}

  @Get()
  async list(@Query() query: ListBillsQuery, @CurrentMerchantContext() ctx: MerchantContext): Promise<PortalBillListResult> {
    return this.portalBillsService.list(ctx.merchantId, {
      filters: {
        dateFrom: parseIsoDate(query.dateFrom, 'dateFrom'),
        dateTo: parseIsoDate(query.dateTo, 'dateTo'),
        billType: parseBillType(query.billType),
        source: parseSource(query.source),
      },
      cursor: query.cursor,
      limit: parseLimit(query.limit),
    });
  }
}
