// H-1: GET /portal/bills. SessionGuard (A-3) resolves MerchantContext and
// re-checks eligibility on every request; @Roles per D-50 — history is
// readable by MERCHANT_ADMIN and STORE_STAFF, same as the roadmap states
// (rbac.md is referenced there but absent from docs/; D-50's own text is
// the source of truth used here).
import { Controller, Get, Param, Post, Query, Res, UnprocessableEntityException, UseGuards } from '@nestjs/common';
import { Channel, UserRole } from '@prisma/client';
import { SessionGuard } from '../auth/session.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentMerchantContext, MerchantContext } from '../auth/merchant-context';
import { PortalBillDetailDto, PortalBillListResult, PortalBillsService } from './portal-bills.service';
import { PortalDeliveriesService } from './portal-deliveries.service';
import { PiiExportAuditService, ExportAuditFilters } from './pii-export-audit.service';
import { serializeBillsCsv } from './bills-export-csv.util';
import { parseBillType, parseIsoDate, parseLimit, parseSource } from './portal-bills-filters.util';

interface ListBillsQuery {
  cursor?: string;
  limit?: string;
  dateFrom?: string;
  dateTo?: string;
  billType?: string;
  source?: string;
}

interface ExportBillsQuery {
  contact?: string;
  dateFrom?: string;
  dateTo?: string;
  billType?: string;
  source?: string;
}

// Minimal shape of the parts of the express Response the CSV handler uses —
// same pattern bills.controller.ts follows to avoid an @types/express dep.
interface CsvResponse {
  status(code: number): void;
  setHeader(name: string, value: string): void;
  send(body: string): void;
}

@Controller('portal/bills')
@UseGuards(SessionGuard)
@Roles(UserRole.MERCHANT_ADMIN, UserRole.STORE_STAFF)
export class PortalBillsController {
  constructor(
    private readonly portalBillsService: PortalBillsService,
    private readonly portalDeliveriesService: PortalDeliveriesService,
    private readonly piiExportAuditService: PiiExportAuditService,
  ) {}

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

  // E-2 / D-70 / D-71 / D-81: CSV export. MERCHANT_ADMIN only (method-level
  // override of the class read-tier — a portable file that leaves the system,
  // D-71). Declared BEFORE @Get(':id') so "export.csv" is not captured as a
  // bill id.
  //
  // SEQUENCING (D-80 §2), do not reorder:
  //   1. contact param -> 422 INVALID_CONTACT_PARAM, ZERO DB activity
  //   2. filters -> 400 (parse*), still zero DB
  //   3. materialize the merchant-scoped, filter-matched rows
  //   4. await auditService.record({ rowCount, projection, filters }) to commit
  //   5. record() rejects -> plain 500, ZERO CSV bytes (no committed row, no export)
  //   6. only now serialize + send. A serializer failure here is the D-80 §3
  //      accepted case: 500, no file, orphan audit row remains.
  @Get('export.csv')
  @Roles(UserRole.MERCHANT_ADMIN)
  async exportCsv(
    @Query() query: ExportBillsQuery,
    @CurrentMerchantContext() ctx: MerchantContext,
    @Res() res: CsvResponse,
  ): Promise<void> {
    // 1. contact — first, before anything touches the DB.
    if (query.contact !== 'masked' && query.contact !== 'full') {
      throw new UnprocessableEntityException({
        error_code: 'INVALID_CONTACT_PARAM',
        message: "contact must be 'masked' or 'full'",
      });
    }
    const contact = query.contact;

    // 2. the other filters — same parsers H-1's list uses (D-80: no duplication).
    const dateFrom = parseIsoDate(query.dateFrom, 'dateFrom');
    const dateTo = parseIsoDate(query.dateTo, 'dateTo');
    const billType = parseBillType(query.billType);
    const source = parseSource(query.source);

    // 3. materialize all matching rows (D-81: unbounded, no cursor — the exact
    // count must be known before the audit commits).
    const rows = await this.portalBillsService.exportRows(ctx.merchantId, { dateFrom, dateTo, billType, source });

    // 4. the audit row — only the filters the merchant actually sent, as strings.
    const auditFilters: ExportAuditFilters = {
      ...(query.dateFrom !== undefined ? { dateFrom: query.dateFrom } : {}),
      ...(query.dateTo !== undefined ? { dateTo: query.dateTo } : {}),
      ...(billType ? { billType } : {}),
      ...(source ? { source } : {}),
    };
    await this.piiExportAuditService.record({
      merchantId: ctx.merchantId,
      userId: ctx.userId,
      rowCount: rows.length,
      contactProjection: contact,
      filters: auditFilters,
    });

    // 6. audit committed — now the file.
    const csv = serializeBillsCsv(rows, contact);
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    res.status(200);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="bills-export-${ctx.merchantId.slice(0, 8)}-${stamp}.csv"`);
    res.send(csv);
  }

  // H-3 / D-47: another merchant's :id (or a nonexistent one) -> 404, never
  // 403 — see PortalBillsService.findOne's own comment for the mechanism.
  @Get(':id')
  async detail(@Param('id') id: string, @CurrentMerchantContext() ctx: MerchantContext): Promise<PortalBillDetailDto> {
    return this.portalBillsService.findOne(ctx.merchantId, id);
  }

  // R-2 / D-69 / D-79: re-queue a FAILED delivery. MERCHANT_ADMIN only
  // (method-level override of the class read-tier — resend is a write / PII
  // egress). NO @Body — a `recipient` in the request is structurally unreadable.
  // 201 (Nest default); another merchant's / a nonexistent billId -> 404.
  @Post(':id/resend')
  @Roles(UserRole.MERCHANT_ADMIN)
  async resend(
    @Param('id') id: string,
    @CurrentMerchantContext() ctx: MerchantContext,
  ): Promise<{ resent: true; channel: Channel }> {
    return this.portalDeliveriesService.resend(ctx.merchantId, id);
  }
}
