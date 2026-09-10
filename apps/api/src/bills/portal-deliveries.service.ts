// R-1 / D-48 / D-78: GET /portal/deliveries — per-merchant broadcast status
// counts + a whitelisted list of FAILED deliveries. Read-only; separate from
// the drainer (which owns the queue) and from PortalBillsService (bill facts).
// This file deliberately emits no diagnostic output of any kind — the R-1
// deny-test scans it and fails on any such reference.
import { Injectable } from '@nestjs/common';
import { BroadcastStatus, Channel } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { maskBroadcastRecipient } from '../common/portal-contact-mask.util';
import { resolveMaxBroadcastAttempts } from '../broadcast/broadcast-max-attempts.util';

// No pagination (a merchant's FAILED count should be tiny — D-7 tolerates only
// ~9 min of outage before a row exhausts). This cap is insurance against an
// unbounded findMany, not a page size; >200 failed deliveries is a support
// conversation.
export const PORTAL_DELIVERIES_FAILED_CAP = 200;

// D-48's five contact fields + `billId`. billId is an FK, not contact data
// (D-78): it carries no PII and exists so the UI can link a failed delivery to
// its bill, where R-2's resend lives. The key-set test asserts EXACTLY these
// six keys and explicitly bans `recipient` / `error` / `id` / `orderId`.
export interface PortalDeliveryFailedItemDto {
  channel: Channel;
  status: BroadcastStatus;
  attempts: number;
  sentAt: string | null;
  recipientMasked: string | null;
  billId: string | null;
}

export interface PortalDeliveriesResult {
  // Zero-filled: every BroadcastStatus is present even at 0.
  counts: Record<BroadcastStatus, number>;
  // D-78 / MAJOR-1: the SAME ceiling the drainer enforces (shared
  // resolveMaxBroadcastAttempts). `attempts >= maxAttempts` on a FAILED row
  // means permanently given up; below it means still retrying. Top-level, not
  // per-item — it is one config constant, not a property of a broadcast.
  maxAttempts: number;
  failed: PortalDeliveryFailedItemDto[];
}

// D-48 discipline: the whitelist is enforced HERE, at the one construction
// site. Never spread a raw Broadcast row into the response.
function toFailedItemDto(row: {
  channel: Channel;
  status: BroadcastStatus;
  attempts: number;
  sentAt: Date | null;
  recipient: string;
  order: { bill: { id: string } | null };
}): PortalDeliveryFailedItemDto {
  return {
    channel: row.channel,
    status: row.status,
    attempts: row.attempts,
    // Always null for a FAILED row (never sent) — kept because D-48 lists it.
    sentAt: row.sentAt?.toISOString() ?? null,
    recipientMasked: maskBroadcastRecipient(row.channel, row.recipient),
    billId: row.order.bill?.id ?? null,
  };
}

@Injectable()
export class PortalDeliveriesService {
  constructor(private readonly prisma: PrismaService) {}

  // merchantId is a mandatory argument, sourced from MerchantContext by the
  // controller (D-46) — never a query param, never the environment. Broadcast
  // has no merchantId column; the scope is the relation filter
  // `order: { merchantId }` (Broadcast.orderId -> Order.merchantId), applied
  // identically to the counts query and the FAILED list query below.
  async getDeliveries(merchantId: string): Promise<PortalDeliveriesResult> {
    const [grouped, failedRows] = await Promise.all([
      this.prisma.broadcast.groupBy({
        by: ['status'],
        where: { order: { merchantId } },
        _count: { _all: true },
      }),
      this.prisma.broadcast.findMany({
        where: { status: BroadcastStatus.FAILED, order: { merchantId } },
        orderBy: { createdAt: 'desc' },
        take: PORTAL_DELIVERIES_FAILED_CAP,
        select: {
          channel: true,
          status: true,
          attempts: true,
          sentAt: true,
          recipient: true,
          order: { select: { bill: { select: { id: true } } } },
        },
      }),
    ]);

    const counts: Record<BroadcastStatus, number> = {
      [BroadcastStatus.PENDING]: 0,
      [BroadcastStatus.SENT]: 0,
      [BroadcastStatus.FAILED]: 0,
    };
    for (const g of grouped) {
      counts[g.status] = g._count._all;
    }

    return {
      counts,
      maxAttempts: resolveMaxBroadcastAttempts(),
      failed: failedRows.map(toFailedItemDto),
    };
  }
}
