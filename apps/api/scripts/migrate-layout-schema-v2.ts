// T-5: one-shot migration of every Template.layoutSchema row to the v2 envelope
// via T-4's normalizeToV2. Bill.layoutSnapshot is a separate column and is never
// written here (D-29) — the renderer normalizes v1 snapshots at read time instead.
//
// Usage: pnpm migrate:layout-schema-v2

import * as path from 'path';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { normalizeToV2, LayoutSchemaDoc } from '@digital-billing/block-manifest';

config({ path: path.join(__dirname, '..', '.env') });

const prisma = new PrismaClient();

function isV2(doc: unknown): boolean {
  return !Array.isArray(doc) && (doc as { schemaVersion?: number })?.schemaVersion === 2;
}

async function main() {
  const templates = await prisma.template.findMany();

  const targets = templates.filter((t) => !isV2(t.layoutSchema));

  if (targets.length === 0) {
    console.log('Every Template.layoutSchema is already v2 — nothing to migrate.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Migrating ${targets.length} of ${templates.length} Template row(s) to layoutSchema v2...`);

  for (const template of targets) {
    const v2 = normalizeToV2(template.layoutSchema as unknown as LayoutSchemaDoc, template.skeleton);
    await prisma.template.update({
      where: { id: template.id },
      data: { layoutSchema: v2 as object },
    });
    console.log(`  Template ${template.id} -> schemaVersion:2 (${v2.blocks.length} blocks)`);
  }

  console.log(`Done. ${targets.length} template(s) migrated. Bill.layoutSnapshot untouched.`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  await prisma.$disconnect();
  console.error('Migration failed:', err);
  process.exit(1);
});
