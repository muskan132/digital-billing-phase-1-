// H-1 / E-2 / D-81: the bill-list query-string filter parsers, extracted from
// portal-bills.controller.ts so PortalBillsController.list and the E-2 CSV
// export share one implementation (D-80's "no duplication of H-1's logic").
// Pure, throw-on-bad-input, no side effects. Zero behaviour change from the
// inlined originals.
import { BadRequestException } from '@nestjs/common';
import { BillType, OrderSource } from '@prisma/client';

export function parseIsoDate(value: string | undefined, paramName: string): Date | undefined {
  if (value === undefined) return undefined;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(`${paramName} must be a valid ISO 8601 date`);
  }
  return parsed;
}

export function parseBillType(value: string | undefined): BillType | undefined {
  if (value === undefined) return undefined;
  if (!Object.values(BillType).includes(value as BillType)) {
    throw new BadRequestException(`billType must be one of ${Object.values(BillType).join(', ')}`);
  }
  return value as BillType;
}

export function parseSource(value: string | undefined): OrderSource | undefined {
  if (value === undefined) return undefined;
  if (!Object.values(OrderSource).includes(value as OrderSource)) {
    throw new BadRequestException(`source must be one of ${Object.values(OrderSource).join(', ')}`);
  }
  return value as OrderSource;
}

export function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new BadRequestException('limit must be an integer');
  }
  return parsed;
}
