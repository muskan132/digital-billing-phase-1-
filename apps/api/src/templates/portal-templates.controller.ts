// W-2/W-3: GET /portal/templates(/:id) — read-only list/detail, for the
// dashboard and the builder's initial load. W-3 adds the mutating builder
// routes (save/save-as/set-default/archive) below, reusing TemplatesService
// exactly as-is (D-46) — SessionGuard/MerchantContext instead of
// DemoOnlyGuard/SEED_MERCHANT_ID, same fork-on-write mechanics (D-32/D-33),
// same 404-not-403 cross-merchant scoping (D-47), already built into every
// TemplatesService method. /demo/templates (TemplatesController) is
// untouched (D-49).
//
// D-59: writes are @Roles(MERCHANT_ADMIN) ONLY, overriding the class-level
// MERCHANT_ADMIN+STORE_STAFF read default at the METHOD level — this is
// the first controller in the app where that distinction actually matters,
// which is exactly what surfaced the D-59 bug.
import { Body, Controller, Delete, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { SessionGuard } from '../auth/session.guard';
import { Roles } from '../auth/roles.decorator';
import { CurrentMerchantContext, MerchantContext } from '../auth/merchant-context';
import { CreateTemplateBody, SaveAsBody, SaveTemplateBody, TemplatesService } from './templates.service';

export interface PortalTemplateListItemDto {
  id: string;
  name: string;
  billType: string;
  skeleton: string;
  version: number;
  isDefault: boolean;
}

export interface PortalTemplateListResult {
  templates: PortalTemplateListItemDto[];
  defaultTemplateId: string | null;
}

// F-6 (D-76): the dashboard "Default templates" module reads this.
export interface PortalTemplateDefaultRef {
  id: string;
  name: string;
}
export interface PortalTemplateDefaultsResult {
  receipt: PortalTemplateDefaultRef | null;
  taxInvoice: PortalTemplateDefaultRef | null;
}
export interface PortalSetDefaultResult {
  defaultReceiptTemplateId: string | null;
  defaultTaxInvoiceTemplateId: string | null;
}

// D-50: same read access as history (MERCHANT_ADMIN + STORE_STAFF) — a
// dashboard list is a read, not a builder write.
@Controller('portal/templates')
@UseGuards(SessionGuard)
@Roles(UserRole.MERCHANT_ADMIN, UserRole.STORE_STAFF)
export class PortalTemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  @Get()
  async list(@CurrentMerchantContext() ctx: MerchantContext): Promise<PortalTemplateListResult> {
    const [templates, defaultTemplateId] = await Promise.all([
      this.templatesService.list(ctx.merchantId),
      this.templatesService.getDefaultTemplateId(ctx.merchantId),
    ]);

    return {
      templates: templates.map((t) => ({
        id: t.id,
        name: t.name,
        billType: t.billType,
        skeleton: t.skeleton,
        version: t.version,
        isDefault: t.id === defaultTemplateId,
      })),
      defaultTemplateId,
    };
  }

  // F-5 (D-65): the archived view — the merchant's archived templates, so the
  // builder (F-8) can offer a restore. Read-tier (MERCHANT_ADMIN + STORE_STAFF,
  // class-level default), same as list(). Declared BEFORE @Get(':id') so the
  // literal path segment "archived" is not captured as a template id.
  @Get('archived')
  async listArchived(@CurrentMerchantContext() ctx: MerchantContext): Promise<PortalTemplateListItemDto[]> {
    const templates = await this.templatesService.listArchived(ctx.merchantId);
    return templates.map((t) => ({
      id: t.id,
      name: t.name,
      billType: t.billType,
      skeleton: t.skeleton,
      version: t.version,
      // An archived template is never a current default — archive() refuses the
      // current default and setDefault() refuses an archived row.
      isDefault: false,
    }));
  }

  // F-6 (D-76): the two default pointers resolved to { id, name }, for the
  // dashboard "Default templates" module. Read-tier (MERCHANT_ADMIN +
  // STORE_STAFF, class-level default) — the change action is the MERCHANT_ADMIN
  // set-default route below. Declared BEFORE @Get(':id') so "defaults" is not
  // captured as a template id.
  @Get('defaults')
  async defaults(@CurrentMerchantContext() ctx: MerchantContext): Promise<PortalTemplateDefaultsResult> {
    return this.templatesService.getDefaults(ctx.merchantId);
  }

  // Read — same MERCHANT_ADMIN+STORE_STAFF as list() (class-level default,
  // no method-level override needed). D-47: another merchant's/nonexistent
  // id both 404 via the exact same findFirst TemplatesService already uses.
  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentMerchantContext() ctx: MerchantContext) {
    return this.templatesService.findOne(id, ctx.merchantId);
  }

  // F-3 (D-66): create-from-scratch. { name, billType, skeleton } — the starting
  // document is server-built (visible HEADER + visible ITEMS), so no layoutSchema
  // is accepted. MERCHANT_ADMIN only (D-50/D-59), like every other builder write.
  @Post()
  @HttpCode(201)
  @Roles(UserRole.MERCHANT_ADMIN)
  async create(@Body() body: CreateTemplateBody, @CurrentMerchantContext() ctx: MerchantContext) {
    return this.templatesService.create(body, ctx.merchantId);
  }

  // D-50/D-59: builder writes are MERCHANT_ADMIN only.
  @Post(':id/save')
  @HttpCode(201)
  @Roles(UserRole.MERCHANT_ADMIN)
  async save(@Param('id') id: string, @Body() body: SaveTemplateBody, @CurrentMerchantContext() ctx: MerchantContext) {
    return this.templatesService.save(id, body, ctx.merchantId);
  }

  // F-2 (D-62): Save As — replaces clone(). Takes { name, layoutSchema }; works
  // from a starter or the merchant's own template; persists the edited body doc
  // into a new lineage without touching the source.
  @Post(':id/save-as')
  @HttpCode(201)
  @Roles(UserRole.MERCHANT_ADMIN)
  async saveAs(@Param('id') id: string, @Body() body: SaveAsBody, @CurrentMerchantContext() ctx: MerchantContext) {
    return this.templatesService.saveAs(id, body, ctx.merchantId);
  }

  // F-6 (D-76): returns only the two pointer ids — TemplatesService.setDefault
  // never hands back the raw Merchant row (secretKeyEnc / gstin / address).
  @Post(':id/set-default')
  @Roles(UserRole.MERCHANT_ADMIN)
  async setDefault(
    @Param('id') id: string,
    @CurrentMerchantContext() ctx: MerchantContext,
  ): Promise<PortalSetDefaultResult> {
    return this.templatesService.setDefault(id, ctx.merchantId);
  }

  @Post(':id/archive')
  @Roles(UserRole.MERCHANT_ADMIN)
  async archive(@Param('id') id: string, @CurrentMerchantContext() ctx: MerchantContext) {
    return this.templatesService.archive(id, ctx.merchantId);
  }

  // F-5 (D-65): restore an archived template — clears archivedAt; F-1's
  // allocator auto-suffixes the name to `(n)` if it has since been taken.
  // MERCHANT_ADMIN only, like every builder write. A second merchant's id, a
  // starter's id, or a not-currently-archived id all → 404 (D-47).
  @Post(':id/restore')
  @Roles(UserRole.MERCHANT_ADMIN)
  async restore(@Param('id') id: string, @CurrentMerchantContext() ctx: MerchantContext) {
    return this.templatesService.restore(id, ctx.merchantId);
  }

  // F-4 (D-64): hard-delete the entire lineage. 200 { deletedCount }.
  // MERCHANT_ADMIN only; refused (422) if any version issued a bill or is a
  // current default; a second merchant's / a starter's id → 404.
  @Delete(':id')
  @HttpCode(200)
  @Roles(UserRole.MERCHANT_ADMIN)
  async deleteLineage(@Param('id') id: string, @CurrentMerchantContext() ctx: MerchantContext) {
    return this.templatesService.deleteLineage(id, ctx.merchantId);
  }
}
