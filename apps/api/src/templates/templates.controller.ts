import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { DemoOnlyGuard } from '../demo/demo-only.guard';
import { TemplatesService } from './templates.service';

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
}
