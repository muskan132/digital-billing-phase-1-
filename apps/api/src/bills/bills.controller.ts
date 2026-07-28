import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiKeyGuard } from './api-key.guard';
import { BillsService } from './bills.service';
import { CreateBillDto } from './dto/create-bill.dto';

interface StatusSettableResponse {
  status(code: number): void;
}

@Controller('v1/bills')
export class BillsController {
  constructor(private readonly billsService: BillsService) {}

  @Post()
  @UseGuards(ApiKeyGuard)
  async create(
    @Body() dto: CreateBillDto,
    @Req() req: { merchantId: string },
    @Res({ passthrough: true }) res: StatusSettableResponse,
  ) {
    const { created, body } = await this.billsService.createBill(dto, req.merchantId);
    res.status(created ? 201 : 200);
    return body;
  }
}
