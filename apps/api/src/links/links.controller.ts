import { Controller, Get, Param } from '@nestjs/common';
import { LinksService } from './links.service';

@Controller('v1/links')
export class LinksController {
  constructor(private readonly linksService: LinksService) {}

  @Get(':identifier')
  async resolve(@Param('identifier') identifier: string) {
    return this.linksService.resolve(identifier);
  }
}
