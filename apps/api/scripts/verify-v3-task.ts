// Single-command replacement for manually running each v1/v2/v3 test suite
// and eyeballing Prisma Studio after a roadmap task. Runs all four suites,
// checks the two v3 DB invariants directly, and prints one PASS/FAIL summary.
//
// Usage: pnpm verify              (from repo root)
//        pnpm --filter @digital-billing/api verify   (equivalent)
//
// Q-4 / D-95: Bill.layoutSnapshot must never change once written (D-29). This
// used to be proven against a committed baseline file (prisma/fixtures/
// layout-snapshot-baseline.json) that only ever covered bills present in it —
// any bill created after the last --write-baseline commit had zero
// protection. The baseline file is retired; every bill now self-certifies via
// Bill.layoutSnapshotHash, written once at creation (callbacks.service.ts's
// P-1, bills.service.ts's P-2) and checked here against every row in the DB.

import { execSync } from 'child_process';
import * as path from 'path';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { hashSnapshot } from '../src/common/layout-snapshot-hash.util';

config({ path: path.join(__dirname, '..', '.env') });

const repoRoot = path.join(__dirname, '..', '..', '..');

interface CheckResult {
  name: string;
  ok: boolean;
  summary: string;
  detail?: string;
}

function runSuite(name: string, cmd: string): CheckResult {
  // Jest (and tsc, on error) write their summary to stderr, not stdout —
  // redirect stderr into the captured stream or the "Tests:" line is lost.
  try {
    const output = execSync(`${cmd} 2>&1`, { cwd: repoRoot, encoding: 'utf8' });
    const match = output.match(/Tests:\s*(.+)/);
    return { name, ok: true, summary: match ? match[1].trim() : 'ok' };
  } catch (err) {
    const e = err as { stdout?: string };
    const output = e.stdout ?? '';
    const match = output.match(/Tests:\s*(.+)/);
    return {
      name,
      ok: false,
      summary: match ? match[1].trim() : 'failed (see detail)',
      detail: output.trim(),
    };
  }
}

async function checkTemplateSchemaVersion(prisma: PrismaClient): Promise<CheckResult> {
  const templates = await prisma.template.findMany({ select: { id: true, layoutSchema: true } });
  const offenders = templates.filter((t) => {
    const doc = t.layoutSchema as { schemaVersion?: number } | unknown[];
    return Array.isArray(doc) || (doc as { schemaVersion?: number })?.schemaVersion !== 2;
  });
  const ok = offenders.length === 0;
  return {
    name: 'Template.layoutSchema is v2 on every row',
    ok,
    summary: ok
      ? `${templates.length}/${templates.length} rows at schemaVersion:2`
      : `${offenders.length}/${templates.length} row(s) NOT v2`,
    detail: ok ? undefined : offenders.map((o) => `  ${o.id}`).join('\n'),
  };
}

export async function checkLayoutSnapshotImmutability(prisma: PrismaClient): Promise<CheckResult> {
  const name = 'Bill.layoutSnapshot unchanged (self-certified via layoutSnapshotHash)';
  const bills = await prisma.bill.findMany({ select: { id: true, layoutSnapshot: true, layoutSnapshotHash: true } });

  const mismatches: string[] = [];
  let checked = 0;
  let skippedNoSnapshot = 0;
  for (const bill of bills) {
    if (bill.layoutSnapshot === null) {
      // Nothing to protect — same as the retired baseline file's behavior.
      skippedNoSnapshot++;
      continue;
    }
    checked++;
    if (bill.layoutSnapshotHash === null) {
      mismatches.push(`  ${bill.id}: has a layoutSnapshot but no layoutSnapshotHash — run scripts/backfill-layout-snapshot-hash.ts`);
      continue;
    }
    if (hashSnapshot(bill.layoutSnapshot) !== bill.layoutSnapshotHash) {
      mismatches.push(`  ${bill.id}: layoutSnapshot hash changed — immutability violated`);
    }
  }

  const ok = mismatches.length === 0;
  return {
    name,
    ok,
    summary: ok
      ? `${checked}/${checked} bill(s) unchanged${skippedNoSnapshot > 0 ? `, ${skippedNoSnapshot} with no snapshot skipped` : ''}`
      : `${mismatches.length} mismatch(es)`,
    detail: ok ? undefined : mismatches.join('\n'),
  };
}

async function main() {
  const prisma = new PrismaClient();

  const results: CheckResult[] = [];

  results.push(runSuite('block-manifest tests', 'pnpm --filter @digital-billing/block-manifest test'));
  results.push(runSuite('web typecheck', 'pnpm --filter @digital-billing/web typecheck'));
  results.push(runSuite('web tests', 'pnpm --filter @digital-billing/web test'));
  results.push(runSuite('api tests', 'pnpm --filter @digital-billing/api test'));
  results.push(await checkTemplateSchemaVersion(prisma));
  results.push(await checkLayoutSnapshotImmutability(prisma));

  await prisma.$disconnect();

  const failures = results.filter((r) => !r.ok);

  console.log('\n=== verify-v3-task ===\n');
  for (const r of results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name} — ${r.summary}`);
  }

  if (failures.length > 0) {
    console.log('\n--- failure detail ---');
    for (const f of failures) {
      console.log(`\n# ${f.name}\n${f.detail}`);
    }
  }

  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'} — ${results.length - failures.length}/${results.length} checks passed\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}

// Guarded so importing checkLayoutSnapshotImmutability for testing (Q-4)
// doesn't also kick off the full runSuite()/process.exit() flow.
if (require.main === module) {
  main().catch((err) => {
    console.error('verify-v3-task crashed:', err);
    process.exit(1);
  });
}
