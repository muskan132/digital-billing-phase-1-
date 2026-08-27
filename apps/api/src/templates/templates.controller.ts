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

  @Post(':id/clone')
  @HttpCode(201)
  async clone(@Param('id') id: string, @CurrentMerchantContext() ctx: MerchantContext) {
    return this.templatesService.clone(id, ctx.merchantId);
  }

  @Post(':id/set-default')
  async setDefault(@Param('id') id: string, @CurrentMerchantContext() ctx: MerchantContext) {
    return this.templatesService.setDefault(id, ctx.merchantId);
  }

  @Post(':id/archive')
  async archive(@Param('id') id: string, @CurrentMerchantContext() ctx: MerchantContext) {
    return this.templatesService.archive(id, ctx.merchantId);
  }
}
