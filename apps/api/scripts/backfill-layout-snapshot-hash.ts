// Q-4 / D-95 backfill — one-time, manual. Populates Bill.layoutSnapshotHash
// for bills written before this column existed (layoutSnapshotHash IS NULL,
// layoutSnapshot present). Treats each bill's CURRENT layoutSnapshot as the
// trusted floor — the same "current DB state is the known-good floor"
// assumption the retired --write-baseline flag used to require an operator
// to confirm by hand before running.
//
// Usage: pnpm backfill:layout-snapshot-hash

import * as path from 'path';
import { config } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import { hashSnapshot } from '../src/common/layout-snapshot-hash.util';

config({ path: path.join(__dirname, '..', '.env') });

const prisma = new PrismaClient();

async function main() {
  const targets = await prisma.bill.findMany({
    // layoutSnapshotHash is a plain String? column (SQL NULL is `null`, not
    // Prisma.DbNull — DbNull is only for the Json? layoutSnapshot column).
    where: { layoutSnapshotHash: null, layoutSnapshot: { not: Prisma.DbNull } },
    select: { id: true, layoutSnapshot: true },
  });

  if (targets.length === 0) {
    console.log('No bills with a null layoutSnapshotHash — nothing to backfill.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Backfilling layoutSnapshotHash for ${targets.length} bill(s) from their current layoutSnapshot...`);

  for (const bill of targets) {
    const layoutSnapshotHash = hashSnapshot(bill.layoutSnapshot);
    await prisma.bill.update({ where: { id: bill.id }, data: { layoutSnapshotHash } });
    console.log(`  Bill ${bill.id} <- ${layoutSnapshotHash}`);
  }

  console.log(`Done. ${targets.length} bill(s) backfilled.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  await prisma.$disconnect();
  console.error('Backfill failed:', err);
  process.exit(1);
});
