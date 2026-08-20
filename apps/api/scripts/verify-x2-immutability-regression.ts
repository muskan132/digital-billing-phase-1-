// X-2 — regression: re-run TEMPLATE_SYSTEM_v2 §7's immutability guarantee against a
// REAL, DB-backed builder edit, not the mocked unit test in
// layout-snapshot-immutability.spec.ts. Exercises the actual production services —
// TemplatesService.clone/save (C-2/C-3, real Prisma, real transaction) and
// BillsService.createBill / LinksService.resolve (real write + read paths) — against a
// live database. No mocks anywhere in this script.
//
// What it proves: create a real bill against a real (merchant-owned) template, then
// fork-on-write that template three times via the real save() path (three distinct
// builder edits), and after every single fork, confirm the bill's Bill.layoutSnapshot
// is byte-identical to what was frozen at creation, and that LinksService.resolve()
// — the real public-page read path — still returns exactly the original block list.
//
// Per the roadmap: "Verification task, no new code expected... If any code change is
// needed here, that is a finding." This script makes no production-code change; it
// only proves (or disproves) that C-2's fork-on-write cannot touch an issued bill.
//
// Usage: pnpm --filter @digital-billing/api exec ts-node scripts/verify-x2-immutability-regression.ts

import * as path from 'path';
import { config } from 'dotenv';
import { PrismaService } from '../src/prisma/prisma.service';
import { TemplatesService } from '../src/templates/templates.service';
import { BillsService } from '../src/bills/bills.service';
import { LinksService } from '../src/links/links.service';
import { CreateBillDto } from '../src/bills/dto/create-bill.dto';

config({ path: path.join(__dirname, '..', '.env') });

const SEED_MERCHANT_ID = 'seed-merchant-demo';
const SOURCE_PRESET_ID = 'seed-template-retail'; // TAX_INVOICE, library preset — cloned, never forked directly (D-33).

interface LayoutBlock {
  id: string;
  type: string;
  order: number;
  props: Record<string, unknown>;
  width: string;
  visible: boolean;
}

interface LayoutSchemaV2Doc {
  schemaVersion: number;
  skeleton: string;
  blocks: LayoutBlock[];
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

function fail(message: string): never {
  console.error(`\nFAIL — ${message}\n`);
  process.exit(1);
}

function buildDto(templateId: string, suffix: string): CreateBillDto {
  return {
    external_transaction_id: `x2-verify-${suffix}`,
    invoice_number: `INV-X2-VERIFY-${suffix}`,
    place_of_supply: '27',
    currency: 'INR',
    sale_at: '2026-08-20T10:00:00Z',
    template_id: templateId,
    line_items: [
      {
        line_no: 1,
        name: 'Widget',
        hsn: '1234',
        uom: 'NOS',
        quantity: 1,
        unit_price_paise: '100',
        item_discount_paise: '0',
        tax_rate_bp: 700,
        tax_paise: '7',
        cgst_paise: '4',
        sgst_paise: '3',
        igst_paise: '0',
      },
    ],
    totals: { subtotal_paise: '100', bill_discount_paise: '0', discount_paise: '0', tax_paise: '7', total_paise: '107' },
    tax_block: { cgst_paise: '4', sgst_paise: '3', igst_paise: '0' },
  };
}

async function main() {
  const prisma = new PrismaService();
  const templatesService = new TemplatesService(prisma);
  const billsService = new BillsService(prisma);
  const linksService = new LinksService(prisma);

  console.log('\n=== verify-x2-immutability-regression ===\n');

  // ---- Step 1: real C-3 clone — a genuine merchant-owned template to fork against.
  // Presets (merchantId: null) cannot be forked directly (CANNOT_FORK_LIBRARY_PRESET),
  // so this is the same path a real merchant would take before ever editing a template.
  const cloned = await templatesService.clone(SOURCE_PRESET_ID);
  if (cloned.merchantId !== SEED_MERCHANT_ID) fail(`clone() produced merchantId=${cloned.merchantId}, expected ${SEED_MERCHANT_ID}`);
  console.log(`PASS  clone() — new merchant-owned template ${cloned.id} (version ${cloned.version})`);

  // ---- Step 2: real BillsService.createBill — a genuine bill issued against that
  // template, exactly as the public API would produce one.
  const suffix = Date.now().toString();
  const dto = buildDto(cloned.id, suffix);
  const createResult = await billsService.createBill(dto, SEED_MERCHANT_ID);
  if (!createResult.created) fail('createBill() reported created:false on a fresh external_transaction_id');
  const identifier = createResult.body.identifier;
  console.log(`PASS  createBill() — real bill ${createResult.body.bill_id}, link ${identifier}`);

  const billRow = await prisma.bill.findUnique({ where: { id: createResult.body.bill_id }, select: { layoutSnapshot: true } });
  if (!billRow) fail('created bill not found immediately after createBill()');
  const originalSnapshot = billRow!.layoutSnapshot;
  const originalCanonical = canonical(originalSnapshot);
  console.log('PASS  captured Bill.layoutSnapshot at issue time');

  // ---- Step 3: three real C-2 fork-on-write saves, each a distinct builder edit,
  // each checked against the bill immediately after.
  const parentBefore = await prisma.template.findUniqueOrThrow({ where: { id: cloned.id } });
  const parentLayoutBefore = canonical(parentBefore.layoutSchema);

  let headId = cloned.id;
  const lineage = [cloned.id];

  const edits: Array<(doc: LayoutSchemaV2Doc) => LayoutSchemaV2Doc> = [
    // Edit 1: hide a non-required block.
    (doc) => ({
      ...doc,
      blocks: doc.blocks.map((b) => (b.type === 'LOYALTY' ? { ...b, visible: false } : b)),
    }),
    // Edit 2: change a merchant-authored string.
    (doc) => ({
      ...doc,
      blocks: doc.blocks.map((b) =>
        b.type === 'COUPON' ? { ...b, props: { ...b.props, headline: 'X-2 verification edit' } } : b,
      ),
    }),
    // Edit 3: reorder two blocks.
    (doc) => ({
      ...doc,
      blocks: doc.blocks.map((b) => {
        if (b.type === 'QR_CODE') return { ...b, order: 10 };
        if (b.type === 'SURVEY') return { ...b, order: 11 };
        return b;
      }),
    }),
  ];

  for (let i = 0; i < edits.length; i++) {
    const n = i + 1;
    const headBefore = await prisma.template.findUniqueOrThrow({ where: { id: headId } });
    const doc = headBefore.layoutSchema as unknown as LayoutSchemaV2Doc;
    const edited = edits[i](doc);

    const forked = await templatesService.save(headId, { layoutSchema: { blocks: edited.blocks } });
    lineage.push(forked.id);
    console.log(`PASS  save() #${n} — forked ${headId} -> ${forked.id} (version ${forked.version})`);

    // D-32: the row just forked FROM must be byte-unchanged in its layoutSchema.
    const parentAfter = await prisma.template.findUniqueOrThrow({ where: { id: headId } });
    if (canonical(parentAfter.layoutSchema) !== canonical(headBefore.layoutSchema)) {
      fail(`save() #${n} mutated parent ${headId}'s layoutSchema — D-32 violated`);
    }

    // The bill's frozen snapshot must not have moved at all.
    const billAfterSave = await prisma.bill.findUniqueOrThrow({ where: { id: createResult.body.bill_id }, select: { layoutSnapshot: true } });
    if (canonical(billAfterSave.layoutSnapshot) !== originalCanonical) {
      fail(`Bill.layoutSnapshot changed after save() #${n} — §7 immutability violated`);
    }
    console.log(`PASS  Bill.layoutSnapshot byte-unchanged after save() #${n}`);

    // Real public-page read path must still resolve the original blocks.
    const resolved = await linksService.resolve(identifier);
    if (canonical(resolved.bill.layoutSnapshot) !== originalCanonical) {
      fail(`LinksService.resolve() returned a changed layoutSnapshot after save() #${n}`);
    }
    console.log(`PASS  LinksService.resolve() unchanged after save() #${n}`);

    headId = forked.id;
  }

  // ---- Step 4: the very first fork's parent (the cloned template, version 1) must
  // still hold exactly what clone() produced — never touched across all three forks.
  const originalTemplateNow = await prisma.template.findUniqueOrThrow({ where: { id: cloned.id } });
  if (canonical(originalTemplateNow.layoutSchema) !== parentLayoutBefore) {
    fail(`cloned template ${cloned.id}'s layoutSchema drifted across the three saves`);
  }
  console.log(`PASS  cloned template ${cloned.id} — layoutSchema untouched across all 3 forks`);

  // ---- Step 5: exactly one isHead=true across the 4-row lineage (1 clone + 3 forks).
  const lineageRows = await prisma.template.findMany({ where: { id: { in: lineage } }, select: { id: true, isHead: true } });
  const heads = lineageRows.filter((r) => r.isHead);
  if (heads.length !== 1 || heads[0].id !== headId) {
    fail(`lineage has ${heads.length} isHead=true row(s), expected exactly 1 (${headId})`);
  }
  console.log(`PASS  lineage (${lineage.length} rows) — exactly one isHead=true (${headId})`);

  // ---- Step 6: final resolve — the rendered block list is still the ORIGINAL one, not
  // any of the three edited versions.
  const finalResolved = await linksService.resolve(identifier);
  if (canonical(finalResolved.bill.layoutSnapshot) !== originalCanonical) {
    fail('final resolve() does not match the originally frozen layoutSnapshot');
  }
  console.log('PASS  final resolve() — rendered blocks match the original, unedited layout\n');

  console.log(`PASS — all checks passed. Bill ${createResult.body.bill_id} / link ${identifier} rendered its original layout through 3 real fork-on-write saves.\n`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('\nverify-x2-immutability-regression crashed:', err);
  process.exit(1);
});
