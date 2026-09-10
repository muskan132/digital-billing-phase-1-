import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { DemoOnlyGuard } from '../demo/demo-only.guard';
import { CurrentMerchantContext, MerchantContext } from '../auth/merchant-context';
import { SaveTemplateBody, TemplatesService } from './templates.service';

@Controller('v1/templates')
@UseGuards(DemoOnlyGuard)
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  @Get()
  async list(@CurrentMerchantContext() ctx: MerchantContext) {
    return this.templatesService.list(ctx.merchantId);
  }

  @Get(':id')
  async findOne(@Param('id') id: string, @CurrentMerchantContext() ctx: MerchantContext) {
    return this.templatesService.findOne(id, ctx.merchantId);
  }

  @Post(':id/save')
  @HttpCode(201)
  async save(@Param('id') id: string, @Body() body: SaveTemplateBody, @CurrentMerchantContext() ctx: MerchantContext) {
    return this.templatesService.save(id, body, ctx.merchantId);
  }

  // F-2 (D-49/D-62): no demo Save As — the demo builder has no save handler at
  // all and is not backfilled. clone() (the demo's old copy path) is removed.

  @Post(':id/set-default')
  async setDefault(@Param('id') id: string, @CurrentMerchantContext() ctx: MerchantContext) {
    return this.templatesService.setDefault(id, ctx.merchantId);
  }

  @Post(':id/archive')
  async archive(@Param('id') id: string, @CurrentMerchantContext() ctx: MerchantContext) {
    return this.templatesService.archive(id, ctx.merchantId);
  }
}
