// X-3 — final regression: the closing proof that A-3/A-4's tenancy scoping is
// structural across every /portal route built since, not something that happened
// to work route-by-route. Two things this script proves that no prior task's tests
// do, on their own:
//
//   1. Every prior cross-merchant test (H-3, W-3) calls TemplatesService/
//      PortalBillsService methods DIRECTLY, bypassing the guard/routing layer
//      entirely. D-59 was exactly a guard/routing-layer bug that a direct service
//      call could never have caught. This script drives every id-taking /portal
//      route over REAL HTTP, through the real SessionGuard/CsrfGuard/role chain —
//      requires a live apps/api server (same as verify-a1/a2/w1).
//   2. Prior cross-merchant tests assert "the call threw NotFoundException" — never
//      an independent re-SELECT proving the row genuinely didn't change. This script
//      captures each target row's state before a cross-merchant mutation attempt and
//      re-reads it after, asserting byte-identical — not just a 404 status code.
//
// Per the roadmap: "Verification task, no new code expected... If any code change is
// needed here, that is a finding." Any failure below is reported as a labeled
// "X-3 FINDING", not a routine test failure — see fail() below.
//
// Usage: pnpm --filter @digital-billing/api verify:x3   (apps/api server must be running)

import * as path from 'path';
import { config } from 'dotenv';
import { createHash, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { TemplatesService } from '../src/templates/templates.service';
import { BillsService } from '../src/bills/bills.service';
import { LinksService } from '../src/links/links.service';
import { CreateBillDto } from '../src/bills/dto/create-bill.dto';

config({ path: path.join(__dirname, '..', '.env') });

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';
const SOURCE_PRESET_ID = 'seed-template-retail'; // same preset X-2 uses — TAX_INVOICE, has LOYALTY/COUPON/QR_CODE/SURVEY blocks

const prisma = new PrismaClient();
const prismaService = new PrismaService();
const templatesService = new TemplatesService(prismaService);
const billsService = new BillsService(prismaService);
const linksService = new LinksService(prismaService);

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `x3-verify-${prefix}-${Date.now()}-${counter}`;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

// Labeled distinctly from a routine assertion failure, per the roadmap's own framing:
// a code change discovered as necessary here is a finding about A-3/A-4 being
// incomplete, not something to quietly patch.
function findingFail(message: string): never {
  console.error(`\n=== X-3 FINDING ===\n${message}\n===================\n`);
  process.exit(1);
}

function hashToken(token: string): Uint8Array<ArrayBuffer> {
  const digest = createHash('sha256').update(token).digest();
  const out = new Uint8Array(new ArrayBuffer(digest.length));
  out.set(digest);
  return out;
}

interface ScratchSession {
  merchantId: string;
  userId: string;
  rawToken: string;
}

async function createScratchSession(role: 'MERCHANT_ADMIN' | 'STORE_STAFF' = 'MERCHANT_ADMIN'): Promise<ScratchSession> {
  const merchantId = uid('merchant');
  await prisma.merchant.create({
    data: {
      id: merchantId,
      jiopayMid: uid('mid'),
      name: `X-3 verify ${merchantId}`,
      secretKeyEnc: Buffer.from('unused'),
      // G-1/D-25: GST validation requires these whenever place_of_supply is set
      // (buildBillDto always sets it) — same values buildBillDto's '27' expects.
      gstin: '27ABCDE1234F1Z5',
      gstStateCode: '27',
    },
  });
  const userId = uid('user');
  await prisma.user.create({
    data: { id: userId, merchantId, type: 'EXTERNAL', role, email: `${userId}@example.invalid`, subject: userId },
  });
  const rawToken = randomBytes(32).toString('base64url');
  await prisma.merchantSession.create({
    data: { userId, tokenHash: hashToken(rawToken), expiresAt: new Date(Date.now() + 10 * 60_000) },
  });
  return { merchantId, userId, rawToken };
}

async function cleanupMerchant(session: ScratchSession): Promise<void> {
  const orders = await prisma.order.findMany({ where: { merchantId: session.merchantId }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  await prisma.link.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.bill.deleteMany({ where: { merchantId: session.merchantId } });
  await prisma.order.deleteMany({ where: { merchantId: session.merchantId } });
  await prisma.merchantSession.deleteMany({ where: { userId: session.userId } });
  await prisma.user.deleteMany({ where: { id: session.userId } });
  await prisma.merchant.update({ where: { id: session.merchantId }, data: { defaultReceiptTemplateId: null } }).catch(() => {});
  await prisma.template.deleteMany({ where: { merchantId: session.merchantId } });
  await prisma.merchant.deleteMany({ where: { id: session.merchantId } });
}

function cookie(session: ScratchSession): string {
  return `session=${session.rawToken}`;
}

async function csrfToken(session: ScratchSession): Promise<string> {
  const res = await fetch(`${API_BASE}/portal/csrf-token`, { headers: { cookie: cookie(session) } });
  if (!res.ok) findingFail(`could not obtain a CSRF token for a real session: HTTP ${res.status}`);
  const body = (await res.json()) as { token: string };
  return body.token;
}

async function createOwnTemplate(session: ScratchSession, name: string) {
  const template = await prisma.template.create({
    data: {
      id: uid('template'),
      merchantId: session.merchantId,
      name,
      billType: 'RECEIPT',
      layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] },
    },
  });
  await prisma.merchant.update({ where: { id: session.merchantId }, data: { defaultReceiptTemplateId: template.id } });
  return template;
}

function buildBillDto(templateId: string, suffix: string): CreateBillDto {
  return {
    external_transaction_id: `x3-verify-${suffix}`,
    invoice_number: `INV-X3-VERIFY-${suffix}`,
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
  console.log('\n=== X-3: final regression — full cross-merchant probe + portal-forked immutability ===\n');

  // S-11 (D-63 / ROADMAP_v5 S-11 verify): a successful run must leave the
  // Template row count exactly where it started — cleanupMerchant() removes
  // every lineage this script clones or HTTP-forks. Asserted in the outer
  // `finally` after both teardowns.
  const templateCountBefore = await prisma.template.count();

  console.log('Setting up merchant A and merchant B, each with their own template + bill...');
  const merchantA = await createScratchSession();
  const merchantB = await createScratchSession();
  const templateA = await createOwnTemplate(merchantA, 'X-3 merchant A template');
  const templateB = await createOwnTemplate(merchantB, 'X-3 merchant B template');
  const billA = await billsService.createBill(buildBillDto(templateA.id, `a-${Date.now()}`), merchantA.merchantId);
  const billB = await billsService.createBill(buildBillDto(templateB.id, `b-${Date.now()}`), merchantB.merchantId);
  console.log(`   merchant A: ${merchantA.merchantId} (template ${templateA.id}, bill ${billA.body.bill_id})`);
  console.log(`   merchant B: ${merchantB.merchantId} (template ${templateB.id}, bill ${billB.body.bill_id})\n`);

  try {
    // ==================== Part 1: list-route isolation ====================
    console.log('--- Part 1: list-route isolation (single-source-of-truth re-assertion) ---\n');

    const billsAsA = (await fetch(`${API_BASE}/portal/bills`, { headers: { cookie: cookie(merchantA) } }).then((r) => r.json())) as {
      items: { id: string }[];
    };
    const billsAsB = (await fetch(`${API_BASE}/portal/bills`, { headers: { cookie: cookie(merchantB) } }).then((r) => r.json())) as {
      items: { id: string }[];
    };
    const billIdsA = billsAsA.items.map((i) => i.id);
    const billIdsB = billsAsB.items.map((i) => i.id);
    if (!billIdsA.includes(billA.body.bill_id)) findingFail("GET /portal/bills as A does not include A's own bill");
    if (billIdsA.includes(billB.body.bill_id)) findingFail("GET /portal/bills as A includes B's bill — cross-merchant leak");
    if (billIdsB.includes(billA.body.bill_id)) findingFail("GET /portal/bills as B includes A's bill — cross-merchant leak");
    console.log('PASS  GET /portal/bills — A and B see disjoint sets, each including only their own bill');

    const templatesAsA = (await fetch(`${API_BASE}/portal/templates`, { headers: { cookie: cookie(merchantA) } }).then((r) =>
      r.json(),
    )) as { templates: { id: string }[] };
    const templatesAsB = (await fetch(`${API_BASE}/portal/templates`, { headers: { cookie: cookie(merchantB) } }).then((r) =>
      r.json(),
    )) as { templates: { id: string }[] };
    const tplIdsA = templatesAsA.templates.map((t) => t.id);
    const tplIdsB = templatesAsB.templates.map((t) => t.id);
    if (!tplIdsA.includes(templateA.id)) findingFail("GET /portal/templates as A does not include A's own template");
    if (tplIdsA.includes(templateB.id)) findingFail("GET /portal/templates as A includes B's template — cross-merchant leak");
    if (tplIdsB.includes(templateA.id)) findingFail("GET /portal/templates as B includes A's template — cross-merchant leak");
    console.log('PASS  GET /portal/templates — A and B see disjoint sets, each including only their own template\n');

    // ==================== Part 2: cross-merchant probe, every id-taking route ====================
    console.log("--- Part 2: every id-taking /portal route, asked for merchant B's resource while authenticated as A ---\n");

    // -- GET /portal/bills/:id — 404-on-fetch, no state to corrupt.
    {
      const res = await fetch(`${API_BASE}/portal/bills/${billB.body.bill_id}`, { headers: { cookie: cookie(merchantA) } });
      if (res.status !== 404) findingFail(`GET /portal/bills/:id — expected 404 for B's bill as A, got ${res.status}`);
      console.log('PASS  GET /portal/bills/:id -> 404');
    }

    // -- GET /portal/templates/:id — 404-on-fetch.
    {
      const res = await fetch(`${API_BASE}/portal/templates/${templateB.id}`, { headers: { cookie: cookie(merchantA) } });
      if (res.status !== 404) findingFail(`GET /portal/templates/:id — expected 404 for B's template as A, got ${res.status}`);
      console.log('PASS  GET /portal/templates/:id -> 404');
    }

    // -- POST .../save — 404-on-mutate, PLUS a real re-SELECT proving zero write.
    {
      const before = await prisma.template.findUniqueOrThrow({ where: { id: templateB.id } });
      const beforeCount = await prisma.template.count({ where: { merchantId: merchantB.merchantId } });
      const token = await csrfToken(merchantA);
      const res = await fetch(`${API_BASE}/portal/templates/${templateB.id}/save`, {
        method: 'POST',
        headers: { cookie: cookie(merchantA), 'x-csrf-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ layoutSchema: { blocks: [{ id: 'blk_x', type: 'HEADER', order: 1, props: {}, visible: true, width: 'full' }] } }),
      });
      if (res.status !== 404) findingFail(`POST .../save — expected 404 for B's template as A, got ${res.status}`);
      const after = await prisma.template.findUniqueOrThrow({ where: { id: templateB.id } });
      const afterCount = await prisma.template.count({ where: { merchantId: merchantB.merchantId } });
      if (afterCount !== beforeCount) findingFail(`POST .../save on B's template as A -> 404, but merchant B's template COUNT changed (${beforeCount} -> ${afterCount})`);
      if (canonical(after) !== canonical(before)) findingFail("POST .../save on B's template as A -> 404, but B's template row was NOT byte-identical afterward");
      console.log('PASS  POST .../save -> 404, real re-SELECT confirms zero write (row + count unchanged)');
    }

    // -- POST .../clone — 404-on-mutate (clone reads by id first; B's private template is out of A's OR-null scope).
    {
      const beforeCount = await prisma.template.count({ where: { merchantId: merchantA.merchantId } });
      const token = await csrfToken(merchantA);
      const res = await fetch(`${API_BASE}/portal/templates/${templateB.id}/clone`, {
        method: 'POST',
        headers: { cookie: cookie(merchantA), 'x-csrf-token': token },
      });
      if (res.status !== 404) findingFail(`POST .../clone — expected 404 for B's template as A, got ${res.status}`);
      const afterCount = await prisma.template.count({ where: { merchantId: merchantA.merchantId } });
      if (afterCount !== beforeCount) findingFail(`POST .../clone on B's template as A -> 404, but a row was created under A anyway (${beforeCount} -> ${afterCount})`);
      console.log('PASS  POST .../clone -> 404, real re-SELECT confirms zero write');
    }

    // -- POST .../set-default — 404-on-mutate, confirm A's OWN default pointers untouched
    // (S-10/D-60: the single defaultTemplateId column is now split in two — check both,
    // since this probe doesn't care which one templateB's billType would have dispatched to).
    {
      const merchantABefore = await prisma.merchant.findUniqueOrThrow({ where: { id: merchantA.merchantId } });
      const token = await csrfToken(merchantA);
      const res = await fetch(`${API_BASE}/portal/templates/${templateB.id}/set-default`, {
        method: 'POST',
        headers: { cookie: cookie(merchantA), 'x-csrf-token': token },
      });
      if (res.status !== 404) findingFail(`POST .../set-default — expected 404 for B's template as A, got ${res.status}`);
      const merchantAAfter = await prisma.merchant.findUniqueOrThrow({ where: { id: merchantA.merchantId } });
      if (
        merchantAAfter.defaultReceiptTemplateId !== merchantABefore.defaultReceiptTemplateId ||
        merchantAAfter.defaultTaxInvoiceTemplateId !== merchantABefore.defaultTaxInvoiceTemplateId
      ) {
        findingFail("POST .../set-default on B's template as A -> 404, but A's OWN default pointer changed anyway");
      }
      console.log("PASS  POST .../set-default -> 404, A's own default pointers unchanged");
    }

    // -- POST .../archive — 404-on-mutate, confirm B's template archivedAt untouched.
    {
      const before = await prisma.template.findUniqueOrThrow({ where: { id: templateB.id } });
      const token = await csrfToken(merchantA);
      const res = await fetch(`${API_BASE}/portal/templates/${templateB.id}/archive`, {
        method: 'POST',
        headers: { cookie: cookie(merchantA), 'x-csrf-token': token },
      });
      if (res.status !== 404) findingFail(`POST .../archive — expected 404 for B's template as A, got ${res.status}`);
      const after = await prisma.template.findUniqueOrThrow({ where: { id: templateB.id } });
      if (after.archivedAt !== before.archivedAt) findingFail("POST .../archive on B's template as A -> 404, but B's template got archived anyway");
      console.log('PASS  POST .../archive -> 404, B\'s template archivedAt unchanged\n');
    }

    // ==================== Part 3: portal-forked immutability (real HTTP, scratch tenant) ====================
    console.log('--- Part 3: §7 immutability, forked through the REAL /portal HTTP route, against a non-seeded tenant ---\n');

    const merchantC = await createScratchSession();
    try {
      const cloned = await templatesService.clone(SOURCE_PRESET_ID, merchantC.merchantId);
      if (cloned.merchantId !== merchantC.merchantId) findingFail(`clone() produced merchantId=${cloned.merchantId}, expected ${merchantC.merchantId}`);
      console.log(`PASS  clone() (direct, setup only) — new merchant-owned template ${cloned.id}`);

      const createResult = await billsService.createBill(buildBillDto(cloned.id, `c-${Date.now()}`), merchantC.merchantId);
      if (!createResult.created) findingFail('createBill() reported created:false on a fresh external_transaction_id');
      const identifier = createResult.body.identifier;
      const billRow = await prisma.bill.findUniqueOrThrow({ where: { id: createResult.body.bill_id }, select: { layoutSnapshot: true } });
      const originalCanonical = canonical(billRow.layoutSnapshot);
      console.log(`PASS  createBill() — real bill ${createResult.body.bill_id}, link ${identifier}, snapshot captured`);

      const edits: Array<(blocks: unknown[]) => unknown[]> = [
        (blocks) => blocks.map((b) => ((b as { type: string }).type === 'LOYALTY' ? { ...(b as object), visible: false } : b)),
        (blocks) =>
          blocks.map((b) =>
            (b as { type: string }).type === 'COUPON'
              ? { ...(b as { props: object }), props: { ...(b as { props: object }).props, headline: 'X-3 verification edit' } }
              : b,
          ),
        (blocks) =>
          blocks.map((b) => {
            const type = (b as { type: string }).type;
            if (type === 'QR_CODE') return { ...(b as object), order: 10 };
            if (type === 'SURVEY') return { ...(b as object), order: 11 };
            return b;
          }),
      ];

      let headId = cloned.id;
      for (let i = 0; i < edits.length; i++) {
        const n = i + 1;
        const headBefore = await prisma.template.findUniqueOrThrow({ where: { id: headId } });
        const doc = headBefore.layoutSchema as { blocks: unknown[] };
        const editedBlocks = edits[i](doc.blocks);

        const token = await csrfToken(merchantC);
        const res = await fetch(`${API_BASE}/portal/templates/${headId}/save`, {
          method: 'POST',
          headers: { cookie: cookie(merchantC), 'x-csrf-token': token, 'content-type': 'application/json' },
          body: JSON.stringify({ layoutSchema: { blocks: editedBlocks } }),
        });
        if (res.status !== 201) findingFail(`real HTTP POST .../save #${n} failed: HTTP ${res.status}: ${await res.text()}`);
        const forked = (await res.json()) as { id: string };
        console.log(`PASS  real HTTP save() #${n} — forked ${headId} -> ${forked.id}`);

        const billAfterSave = await prisma.bill.findUniqueOrThrow({ where: { id: createResult.body.bill_id }, select: { layoutSnapshot: true } });
        if (canonical(billAfterSave.layoutSnapshot) !== originalCanonical) {
          findingFail(`Bill.layoutSnapshot changed after portal-forked save() #${n} — §7 immutability violated on a PORTAL fork`);
        }
        console.log(`PASS  Bill.layoutSnapshot byte-unchanged after portal-forked save() #${n}`);

        const resolved = await linksService.resolve(identifier);
        if (canonical(resolved.bill.layoutSnapshot) !== originalCanonical) {
          findingFail(`LinksService.resolve() changed after portal-forked save() #${n}`);
        }
        console.log(`PASS  LinksService.resolve() unchanged after portal-forked save() #${n}`);

        headId = forked.id;
      }

      const finalResolved = await linksService.resolve(identifier);
      if (canonical(finalResolved.bill.layoutSnapshot) !== originalCanonical) {
        findingFail('final resolve() does not match the originally frozen layoutSnapshot after 3 portal-forked saves');
      }
      console.log('PASS  final resolve() — rendered blocks match the original, unedited layout\n');
    } finally {
      await cleanupMerchant(merchantC);
    }

    console.log('=== X-3: all checks passed — every /portal route probed, zero writes confirmed, portal-forked immutability holds ===\n');
  } finally {
    await cleanupMerchant(merchantA);
    await cleanupMerchant(merchantB);

    // S-11 (D-63): every scratch lineage this run created must be gone.
    const templateCountAfter = await prisma.template.count();
    if (templateCountAfter !== templateCountBefore) {
      console.error(
        `\n=== X-3 FINDING ===\nTemplate row count changed across this run: ${templateCountBefore} -> ${templateCountAfter} — ` +
          'a scratch lineage leaked past cleanupMerchant()\n===================\n',
      );
      process.exitCode = 1;
    } else {
      console.log(`PASS  Template row count unchanged across the run (${templateCountBefore})`);
    }

    await prisma.$disconnect();
    await prismaService.$disconnect();
  }
}

main().catch(async (err) => {
  console.error('\nverify-x3-final-regression crashed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
