import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { BillsService } from './bills.service';
import { CreateBillDto } from './dto/create-bill.dto';

@Controller('v1/bills')
export class BillsController {
  constructor(private readonly billsService: BillsService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(ApiKeyGuard)
  async create(@Body() dto: CreateBillDto, @Req() req: { merchantId: string }) {
    return this.billsService.createBill(dto, req.merchantId);
  }
}
