import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsIn, IsInt, IsString, Min, ValidateNested } from 'class-validator';
import { DemoOnlyGuard } from './demo-only.guard';
import { DemoService } from './demo.service';

class SimulateCallbackDto {
  @IsIn(['1.00', '10.00', '99.99', '250.00'])
  amount!: string;
}

class CreateDemoInvoiceDto {
  @IsIn(['tax_invoice', 'retail', 'restaurant'])
  fixtureKey!: 'tax_invoice' | 'retail' | 'restaurant';
}

// Standard GST slabs only (0500/1200/1800/2800 bp) — a dropdown, never free text, so
// no operator input can produce a tax rate M-2 wasn't built to handle.
class PreviewInvoiceItemDto {
  @IsString()
  name!: string;

  @IsInt()
  @Min(1)
  quantity!: number;

  @IsString()
  unitPriceRupees!: string;

  @IsIn([500, 1200, 1800, 2800])
  taxRateBp!: number;
}

class PreviewInvoiceDto {
  @ValidateNested({ each: true })
  @Type(() => PreviewInvoiceItemDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(3)
  items!: PreviewInvoiceItemDto[];
}

class CreateInvoiceFromComputedDto {
  @IsIn(['tax_invoice', 'retail', 'restaurant'])
  templateKey!: 'tax_invoice' | 'retail' | 'restaurant';

  // Deliberately untyped/unvalidated here beyond "is an object" — this must be
  // previewInvoice's own response passed back verbatim, not independently
  // re-validated input. Re-validating it would just be reimplementing M-2's
  // shape a second time; computeInvoice (via previewInvoice) is the only source
  // of these numbers.
  line_items!: Record<string, unknown>[];
  totals!: Record<string, string>;
  tax_block!: Record<string, string>;
}

// Demo control panel backend — NOT the merchant portal. Fixed choices only
// (enforced here via @IsIn, mirroring the frontend's fixed dropdowns): no
// free text ever reaches the real /v1/callbacks/pg or /v1/bills paths from
// here, so nothing here can produce a live validation error mid-demo.
@Controller('v1/demo')
@UseGuards(DemoOnlyGuard)
export class DemoController {
  constructor(private readonly demoService: DemoService) {}

  @Post('simulate-callback')
  async simulateCallback(@Body() dto: SimulateCallbackDto) {
    return this.demoService.simulateCallback(dto.amount);
  }

  @Post('create-invoice')
  async createInvoice(@Body() dto: CreateDemoInvoiceDto) {
    return this.demoService.createInvoice(dto.fixtureKey);
  }

  @Post('preview-invoice')
  previewInvoice(@Body() dto: PreviewInvoiceDto) {
    return this.demoService.previewInvoice(dto.items);
  }

  @Post('create-invoice-from-computed')
  async createInvoiceFromComputed(@Body() dto: CreateInvoiceFromComputedDto) {
    return this.demoService.createInvoiceFromComputed(dto.templateKey, {
      line_items: dto.line_items,
      totals: dto.totals,
      tax_block: dto.tax_block,
    });
  }
}
