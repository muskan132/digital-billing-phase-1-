// TEMPLATE_SYSTEM_v2 §7 backfill — one-time, manual. Populates Bill.layoutSnapshot for
// bills written before this column existed (layoutSnapshot IS NULL).
//
// IMPORTANT — historically imperfect, by design and accepted: this freezes each
// existing bill at its template's CURRENT layout, not whatever layout was actually in
// force when the bill was originally issued (that information was never captured
// before this task). Acceptable only because this affects dev/demo data, not a
// production compliance record. Do not run this against real historical data without
// re-reading that caveat.
//
// Usage: pnpm backfill:layout-snapshot

import * as path from 'path';
import { config } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';

config({ path: path.join(__dirname, '..', '.env') });

const prisma = new PrismaClient();

async function main() {
  // Bills written before this column existed have a true SQL NULL here (never set),
  // not a JSON "null" value — Prisma.DbNull is the correct filter for that.
  const targets = await prisma.bill.findMany({
    where: { layoutSnapshot: { equals: Prisma.DbNull } },
    include: { template: true },
  });

  if (targets.length === 0) {
    console.log('No bills with a null layoutSnapshot — nothing to backfill.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Backfilling layoutSnapshot for ${targets.length} bill(s) from their current template state...`);

  for (const bill of targets) {
    await prisma.bill.update({
      where: { id: bill.id },
      data: {
        layoutSnapshot: {
          schemaVersion: 1,
          skeleton: bill.template.skeleton,
          blocks: bill.template.layoutSchema as object,
          templateId: bill.template.id,
          templateVersion: bill.template.version,
        },
      },
    });
    console.log(`  Bill ${bill.id} <- Template ${bill.template.id} (v${bill.template.version}, ${bill.template.skeleton})`);
  }

  console.log(`Done. ${targets.length} bill(s) backfilled at TODAY'S template layout (see caveat above).`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  await prisma.$disconnect();
  console.error('Backfill failed:', err);
  process.exit(1);
});
