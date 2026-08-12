import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { DemoOnlyGuard } from '../demo/demo-only.guard';
import { SaveTemplateBody, TemplatesService } from './templates.service';

@Controller('v1/templates')
@UseGuards(DemoOnlyGuard)
export class TemplatesController {
  constructor(private readonly templatesService: TemplatesService) {}

  @Get()
  async list() {
    return this.templatesService.list();
  }

  @Get(':id')
  async findOne(@Param('id') id: string) {
    return this.templatesService.findOne(id);
  }

  @Post(':id/save')
  @HttpCode(201)
  async save(@Param('id') id: string, @Body() body: SaveTemplateBody) {
    return this.templatesService.save(id, body);
  }

  @Post(':id/clone')
  @HttpCode(201)
  async clone(@Param('id') id: string) {
    return this.templatesService.clone(id);
  }

  @Post(':id/set-default')
  async setDefault(@Param('id') id: string) {
    return this.templatesService.setDefault(id);
  }

  @Post(':id/archive')
  async archive(@Param('id') id: string) {
    return this.templatesService.archive(id);
  }
}
