import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IDENTIFIER_PATTERN } from '../common/link-id.util';

export interface BillViewDto {
  identifier: string;
  merchant: {
    name: string;
  };
  bill: {
    billType: string;
    totalPaise: string;
    currency: string;
    snapshot: unknown;
    template: {
      name: string;
      billType: string;
      layoutSchema: unknown;
    };
  };
}

@Injectable()
export class LinksService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(identifier: string): Promise<BillViewDto> {
    if (!IDENTIFIER_PATTERN.test(identifier)) {
      throw new NotFoundException('Unknown identifier');
    }

    // bill.snapshot is a JSON column — Prisma's `select` whitelists top-level fields
    // only, it cannot filter what's inside a JSON blob. L-2's PII-safety guarantee
    // therefore depends on P-1 (callbacks.service.ts) only ever writing non-PII
    // values into Bill.snapshot. If what P-1 writes into snapshot ever changes,
    // this file's safety assumption needs re-checking.
    const link = await this.prisma.link.findUnique({
      where: { identifier },
      select: {
        identifier: true,
        order: {
          select: {
            merchant: { select: { name: true } },
            // No status check here: P-1 only ever reaches the `link: { create }`
            // nested-write branch inside the SUCCESS upsert — every other exit path
            // (NON_SUCCESS, missing txnId, D-15 unparseable amount, D-14a missing
            // template) returns before a Link is created. A Link row existing is
            // itself proof the Order is SUCCESS with a Bill.
            bill: {
              select: {
                billType: true,
                totalPaise: true,
                currency: true,
                snapshot: true,
                template: {
                  select: {
                    name: true,
                    billType: true,
                    layoutSchema: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!link || !link.order.bill) {
      throw new NotFoundException('Unknown identifier');
    }

    const { bill } = link.order;

    return {
      identifier: link.identifier,
      merchant: { name: link.order.merchant.name },
      bill: {
        billType: bill.billType,
        totalPaise: bill.totalPaise.toString(),
        currency: bill.currency,
        snapshot: bill.snapshot,
        template: bill.template,
      },
    };
  }
}
