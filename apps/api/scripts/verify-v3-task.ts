// Single-command replacement for manually running each v1/v2/v3 test suite
// and eyeballing Prisma Studio after a roadmap task. Runs all four suites,
// checks the two v3 DB invariants directly, and prints one PASS/FAIL summary.
//
// Usage: pnpm verify              (from repo root)
//        pnpm --filter @digital-billing/api verify   (equivalent)
//
// Baseline maintenance: Bill.layoutSnapshot must never change once written
// (D-29). This script proves that by comparing each bill's snapshot hash
// against a committed baseline (prisma/fixtures/layout-snapshot-baseline.json)
// rather than re-diffing the full JSON every run. The baseline only needs to
// be regenerated when bills are deliberately added to fixture/seed data —
// never to "fix" a failing immutability check, since a failure there means
// the invariant was actually violated:
//   pnpm --filter @digital-billing/api exec ts-node scripts/verify-v3-task.ts --write-baseline

import { execSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';

config({ path: path.join(__dirname, '..', '.env') });

const repoRoot = path.join(__dirname, '..', '..', '..');
const baselinePath = path.join(__dirname, '..', 'prisma', 'fixtures', 'layout-snapshot-baseline.json');

interface CheckResult {
  name: string;
  ok: boolean;
  summary: string;
  detail?: string;
}

function canonicalStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashSnapshot(snapshot: unknown): string {
  return crypto.createHash('sha256').update(canonicalStringify(snapshot)).digest('hex');
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

async function checkLayoutSnapshotImmutability(prisma: PrismaClient): Promise<CheckResult> {
  const name = 'Bill.layoutSnapshot unchanged (vs. baseline)';
  if (!fs.existsSync(baselinePath)) {
    return {
      name,
      ok: false,
      summary: 'no baseline file found',
      detail: `Expected ${baselinePath}. Generate it with --write-baseline (see script header) — only after confirming the current DB state is the known-good floor.`,
    };
  }

  const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as { hashes: Record<string, string> };
  const bills = await prisma.bill.findMany({ select: { id: true, layoutSnapshot: true } });
  const current = new Map(bills.map((b) => [b.id, b.layoutSnapshot]));

  const mismatches: string[] = [];
  let checked = 0;
  for (const [billId, expectedHash] of Object.entries(baseline.hashes)) {
    const snapshot = current.get(billId);
    if (snapshot === undefined) {
      mismatches.push(`  ${billId}: in baseline but missing from DB`);
      continue;
    }
    checked++;
    if (hashSnapshot(snapshot) !== expectedHash) {
      mismatches.push(`  ${billId}: layoutSnapshot hash changed — immutability violated`);
    }
  }

  const newBills = bills.length - Object.keys(baseline.hashes).length;
  const ok = mismatches.length === 0;
  return {
    name,
    ok,
    summary: ok
      ? `${checked}/${checked} baseline bill(s) unchanged${newBills > 0 ? `, ${newBills} new bill(s) not yet baselined` : ''}`
      : `${mismatches.length} mismatch(es)`,
    detail: ok ? undefined : mismatches.join('\n'),
  };
}

async function writeBaseline(prisma: PrismaClient) {
  const bills = await prisma.bill.findMany({ select: { id: true, layoutSnapshot: true } });
  const hashes: Record<string, string> = {};
  for (const b of bills) {
    if (b.layoutSnapshot !== null) hashes[b.id] = hashSnapshot(b.layoutSnapshot);
  }
  fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
  fs.writeFileSync(baselinePath, JSON.stringify({ generatedAt: new Date().toISOString(), hashes }, null, 2) + '\n');
  console.log(`Baseline written: ${Object.keys(hashes).length} bill(s) -> ${baselinePath}`);
}

async function main() {
  const prisma = new PrismaClient();

  if (process.argv.includes('--write-baseline')) {
    await writeBaseline(prisma);
    await prisma.$disconnect();
    return;
  }

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

main().catch((err) => {
  console.error('verify-v3-task crashed:', err);
  process.exit(1);
});
