// N-1 / D-83 backfill — populates/recomputes Order.saleAt from Order.paymentDateTime.
//
// Unconditionally recomputes for EVERY row with a non-null paymentDateTime, on every
// run — never gated on `saleAt IS NULL` (unlike Q-4's layoutSnapshotHash backfill,
// which does not apply here per the D-83 addendum). This is what makes "change
// IST_ZONE and re-run" produce a uniformly shifted result: a skip-if-populated
// backfill would find nothing left to touch on a second run. paymentDateTime itself
// is never read from or written to anything derived — always the raw source.
//
// Usage: pnpm backfill:sale-at

import * as path from 'path';
import { config } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import { parseSaleAt, IST_ZONE } from '../src/common/sale-time.util';

export interface BackfillSaleAtResult {
  processed: number;
  changed: number;
  unparseable: number;
}

// The core logic, exported so integration tests can run it against a real DB
// (with a real scratch merchant/orders) without shelling out to this file.
// `merchantId` scopes the run — omitted in production use (the real backfill
// covers every order); integration tests pass their own scratch merchant's id
// so they never touch the shared dev DB's unrelated rows.
export async function backfillSaleAt(
  prisma: PrismaClient,
  offsetMinutes: number = IST_ZONE,
  merchantId?: string,
): Promise<BackfillSaleAtResult> {
  const where: Prisma.OrderWhereInput = {
    paymentDateTime: { not: null },
    ...(merchantId ? { merchantId } : {}),
  };
  const targets = await prisma.order.findMany({
    where,
    select: { id: true, paymentDateTime: true, saleAt: true },
  });

  let changed = 0;
  let unparseable = 0;
  for (const order of targets) {
    const saleAt = parseSaleAt(order.paymentDateTime, offsetMinutes);
    if (saleAt === null) unparseable++;
    if (order.saleAt?.getTime() !== saleAt?.getTime()) changed++;
    await prisma.order.update({ where: { id: order.id }, data: { saleAt } });
  }

  return { processed: targets.length, changed, unparseable };
}

async function main() {
  config({ path: path.join(__dirname, '..', '.env') });
  const prisma = new PrismaClient();

  const result = await backfillSaleAt(prisma);
  if (result.processed === 0) {
    console.log('No orders with a paymentDateTime — nothing to backfill.');
  } else {
    console.log(
      `Done. ${result.processed} order(s) processed, ${result.changed} changed, ${result.unparseable} unparseable (saleAt=null).`,
    );
  }
  await prisma.$disconnect();
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Backfill failed:', err);
    process.exit(1);
  });
}
