// R-1 / D-48 / D-78: GET /portal/deliveries — per-merchant broadcast status
// counts + a whitelisted list of FAILED deliveries.
// R-2 / D-69 / D-79: POST /portal/bills/:id/resend — re-queue a FAILED delivery
// as a NEW Broadcast row for the drainer to pick up.
// Separate from the drainer (which owns the queue) and from PortalBillsService
// (bill facts). This file deliberately emits no diagnostic output of any kind —
// the R-1 deny-test scans it and fails on any such reference.
import { Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { BroadcastStatus, Channel, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { maskBroadcastRecipient } from '../common/portal-contact-mask.util';
import { resolveMaxBroadcastAttempts } from '../broadcast/broadcast-max-attempts.util';

// R-2 / D-79: stable error codes — F-8's "surface the server's named error
// verbatim" pattern depends on these not changing.
export const RESEND_ALREADY_PENDING = 'RESEND_ALREADY_PENDING';
export const NO_FAILED_BROADCAST = 'NO_FAILED_BROADCAST';

// Matches the P2002 from the partial unique index Broadcast_orderId_pending_key
// (migration 20260910200000) — a concurrent resend double-click that beat the
// app-level PENDING count check. Deliberately narrow, same discipline as
// templates.service's isTemplateNameConflict.
function isPendingBroadcastConflict(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
    return false;
  }
  const target = err.meta?.target;
  const fields = Array.isArray(target) ? target.map(String) : typeof target === 'string' ? [target] : [];
  const joined = fields.join('|');
  return /orderId/i.test(joined) && /pending/i.test(joined);
}

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

  // R-2 / D-69 / D-79: re-queue a FAILED delivery. Reads NO request body — the
  // route has no @Body param, so a `recipient` (or anything) in the request is
  // structurally unreadable. Creates ONE new Broadcast row (status PENDING,
  // attempts 0) copying channel + the STORED raw recipient from the order's
  // most-recent FAILED broadcast; the old row is only ever read, never touched.
  // The existing @Cron drainer picks the new row up on its next tick — no new
  // send logic (D-69: "Neither changes the drainer").
  //
  // One transaction: scoped lookup -> PENDING check -> FAILED target -> create.
  // The count check is the friendly path; the partial unique index
  // Broadcast_orderId_pending_key is the structural backstop for a concurrent
  // double-click, its P2002 mapped to the SAME 422 (D-79).
  async resend(merchantId: string, billId: string): Promise<{ resent: true; channel: Channel }> {
    return this.prisma.$transaction(async (tx) => {
      // D-47: id AND merchantId in the same query — a cross-merchant billId and
      // a nonexistent one both come back null and both 404, no distinguishing body.
      const bill = await tx.bill.findFirst({
        where: { id: billId, merchantId },
        select: {
          order: {
            select: {
              id: true,
              broadcasts: { select: { channel: true, recipient: true, status: true, createdAt: true } },
            },
          },
        },
      });
      if (!bill) {
        throw new NotFoundException();
      }

      const broadcasts = bill.order.broadcasts;

      // D-69: "at most one delivery in flight per order" — scope is the ORDER,
      // any channel, any recipient.
      if (broadcasts.some((b) => b.status === BroadcastStatus.PENDING)) {
        throw new UnprocessableEntityException({
          error_code: RESEND_ALREADY_PENDING,
          message: 'A delivery for this bill is already in progress. Wait for it to finish before resending.',
        });
      }

      // D-79: the target is the MOST-RECENT FAILED row. `attempts` is NOT a gate
      // — the merchant asking is a distinct signal from the drainer's own retry
      // schedule (D-69). One channel per order in practice, so "most recent" and
      // "any" FAILED resolve to the same destination.
      const failed = broadcasts
        .filter((b) => b.status === BroadcastStatus.FAILED)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
      if (!failed) {
        throw new UnprocessableEntityException({
          error_code: NO_FAILED_BROADCAST,
          message: 'This bill has no failed delivery to resend.',
        });
      }

      try {
        await tx.broadcast.create({
          data: {
            orderId: bill.order.id,
            channel: failed.channel,
            recipient: failed.recipient, // STORED raw value — never from the request
            status: BroadcastStatus.PENDING,
            attempts: 0,
          },
        });
      } catch (err) {
        if (isPendingBroadcastConflict(err)) {
          // Concurrent double-click — the partial index caught what the count
          // check above missed. Same 422, indistinguishable to the caller.
          throw new UnprocessableEntityException({
            error_code: RESEND_ALREADY_PENDING,
            message: 'A delivery for this bill is already in progress. Wait for it to finish before resending.',
          });
        }
        throw err;
      }

      return { resent: true as const, channel: failed.channel };
    });
  }
}
