// X-4 — Phase 5 closing regression. Plan approved 2026-09-11 (see conversation):
// script-only (no in-suite spec duplication, matching X-3's precedent); asserts
// all SIX starters (five original + I-1's UTILITY) byte-identical plus the D-72
// 422 on Save As from seed-template-utility ("five" in the roadmap row predates
// I-1); adds ONE F-7/D-61 cross-merchant template_id fallback assertion (not a
// verify:f7 re-run); uses A-6's real seeded STORE_STAFF principal via a real
// dev-idp login (not a scratch session row) for the one role-gate gap A-6 left
// (export.csv was never in A-6's write-sweep).
//
// Per the roadmap: "Verification task, no new code expected... If any code
// change is needed here, that is a finding." Any failure below is reported as
// an "X-4 FINDING", not a routine test failure — see findingFail() below.
//
// What this proves, beyond every prior task's own test:
//   1. THE FULL SET TOGETHER, through the real guard chain, in one run — every
//      /portal route added or reshaped this phase (F-2..F-8, R-1, R-2, E-2),
//      probed cross-merchant, over real HTTP. A single route-level bug (the
//      D-59 class) spanning them would not be caught by any one task's own
//      narrower test.
//   2. REAL RE-SELECT, not a status code — every cross-merchant mutation
//      attempt captures the target row's canonical state and a merchant-scoped
//      count() before and after, same discipline X-3 introduced.
//   3. THE FULL PHASE-5 LIFECYCLE SEQUENCE against one live bill's template —
//      three builder edits, a rename (F-1), a Save As (F-2), an archive (F-5),
//      and a restore (F-5) — none of which may touch Bill.layoutSnapshot (§7).
//      X-2 did three direct forks; X-3 did three portal-HTTP forks; neither put
//      rename/Save-As/archive/restore into the sequence.
//   4. SIX-STARTER byte-identical check (not five — I-1 added UTILITY) across a
//      full multi-merchant session, plus D-72's named 422 on Save As from the
//      UTILITY starter.
//
// Usage: pnpm --filter @digital-billing/api verify:x4   (apps/api + dev-idp up)

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
const SOURCE_PRESET_ID = 'seed-template-retail'; // same preset X-2/X-3 use — TAX_INVOICE, LOYALTY/COUPON/QR_CODE/SURVEY blocks to edit
const UTILITY_STARTER_ID = 'seed-template-utility';
const STORE_STAFF_SUBJECT = 'seed-user-store-staff'; // A-6's real seeded principal

// All SIX shared starters (merchantId: null) as of I-1 — the five original plus
// UTILITY. The roadmap row says "the five original starters"; treated here as
// stale pre-I-1 wording per the approved plan, not a deliberate exclusion.
const STARTER_IDS = [
  'seed-template-receipt',
  'seed-template-receipt-thermal',
  'seed-template-tax-invoice',
  'seed-template-retail',
  'seed-template-restaurant',
  'seed-template-utility',
];

const prisma = new PrismaClient();
const prismaService = new PrismaService();
const templatesService = new TemplatesService(prismaService);
const billsService = new BillsService(prismaService);
const linksService = new LinksService(prismaService);

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `x4-verify-${prefix}-${Date.now()}-${counter}`;
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
}

// Labeled distinctly from a routine assertion failure, per the roadmap's own
// framing: a code change discovered as necessary here is a finding about an
// earlier task's guarantee being incomplete, not something to quietly patch.
function findingFail(message: string): never {
  console.error(`\n=== X-4 FINDING ===\n${message}\n===================\n`);
  process.exit(1);
}

function pass(message: string): void {
  console.log(`PASS  ${message}`);
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

async function createScratchSession(): Promise<ScratchSession> {
  const merchantId = uid('merchant');
  await prisma.merchant.create({
    data: {
      id: merchantId,
      jiopayMid: uid('mid'),
      name: `X-4 verify ${merchantId}`,
      secretKeyEnc: Buffer.from('unused'),
      gstin: '27ABCDE1234F1Z5',
      gstStateCode: '27',
    },
  });
  const userId = uid('user');
  await prisma.user.create({
    data: { id: userId, merchantId, type: 'EXTERNAL', role: 'MERCHANT_ADMIN', email: `${userId}@example.invalid`, subject: userId },
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
  await prisma.broadcast.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.bill.deleteMany({ where: { merchantId: session.merchantId } });
  await prisma.order.deleteMany({ where: { merchantId: session.merchantId } });
  await prisma.merchantSession.deleteMany({ where: { userId: session.userId } });
  await prisma.user.deleteMany({ where: { id: session.userId } });
  await prisma.merchant
    .update({ where: { id: session.merchantId }, data: { defaultReceiptTemplateId: null, defaultTaxInvoiceTemplateId: null } })
    .catch(() => {});
  await prisma.template.deleteMany({ where: { merchantId: session.merchantId } });
  // No piiExportAudit cleanup here, deliberately: nothing in this script ever
  // successfully calls export.csv for a scratch merchant (A/B/C), and D-70's
  // append-only guarantee is enforced by a repo-wide grep that scans this very
  // scripts/ directory for a *.deleteMany call — adding one here to tidy up
  // rows that don't exist would trip that guard for no reason.
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

async function createOwnTemplate(session: ScratchSession, name: string, setAsDefault: boolean) {
  // F-7 (D-61): scratch templates are TAX_INVOICE — POST /v1/bills issues
  // TAX_INVOICE bills only.
  const template = await prisma.template.create({
    data: {
      id: uid('template'),
      merchantId: session.merchantId,
      name,
      billType: 'TAX_INVOICE',
      layoutSchema: { schemaVersion: 2, skeleton: 'TAX_COMPLIANT', blocks: [] },
    },
  });
  if (setAsDefault) {
    await prisma.merchant.update({ where: { id: session.merchantId }, data: { defaultTaxInvoiceTemplateId: template.id } });
  }
  return template;
}

function buildBillDto(templateId: string | undefined, suffix: string): CreateBillDto {
  return {
    external_transaction_id: `x4-verify-${suffix}`,
    invoice_number: `INV-X4-VERIFY-${suffix}`,
    place_of_supply: '27',
    currency: 'INR',
    sale_at: '2026-08-20T10:00:00Z',
    ...(templateId ? { template_id: templateId } : {}),
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
  } as CreateBillDto;
}

// ---------------------------------------------------------------------------
// Real-OIDC-login machinery (A-6/A-2's devInteractions simulation, duplicated
// per this repo's convention of self-contained verify scripts).
// ---------------------------------------------------------------------------
interface CookieJar {
  [name: string]: string;
}
function mergeCookies(jar: CookieJar, res: Response) {
  for (const raw of res.headers.getSetCookie()) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    jar[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
}
function cookieHeader(jar: CookieJar): string {
  return Object.entries(jar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function driveRealLogin(subject: string): Promise<{ jar: CookieJar; finalStatus: number }> {
  const jar: CookieJar = {};
  let next = `${API_BASE}/auth/login`;
  let hops = 0;

  while (hops++ < 15) {
    const isCallbackUrl = next.startsWith(`${API_BASE}/auth/callback`);
    const res = await fetch(next, { redirect: 'manual', headers: { cookie: cookieHeader(jar) } });
    mergeCookies(jar, res);

    if (res.status >= 300 && res.status < 400) {
      if (isCallbackUrl) {
        return { jar, finalStatus: 200 };
      }
      next = new URL(res.headers.get('location')!, next).href;
      continue;
    }

    if (res.status === 200 && next.includes('/interaction/')) {
      const uid2 = next.split('/interaction/')[1].split(/[/?]/)[0];
      const html = await res.text();
      const isConsent = html.includes('name="prompt" value="consent"');
      const idpOrigin = new URL(next).origin;
      const body = isConsent
        ? new URLSearchParams({ prompt: 'consent' })
        : new URLSearchParams({ prompt: 'login', login: subject, password: 'irrelevant' });

      const submitRes = await fetch(`${idpOrigin}/interaction/${uid2}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
        body: body.toString(),
      });
      mergeCookies(jar, submitRes);
      next = new URL(submitRes.headers.get('location')!, idpOrigin).href;
      continue;
    }

    return { jar, finalStatus: res.status };
  }
  throw new Error('too many redirects');
}

async function main() {
  console.log('\n=== X-4: Phase 5 closing regression ===\n');

  // S-11 (D-63): a successful run must leave the Template row count exactly
  // where it started. E-1/D-70: same for PiiExportAudit.
  const templateCountBefore = await prisma.template.count();
  const auditCountBefore = await prisma.piiExportAudit.count();

  // ==================== Part 0: snapshot all six starters ====================
  console.log('--- Part 0: snapshot all six starters before any merchant session ---\n');
  const startersBefore = new Map<string, unknown>();
  for (const id of STARTER_IDS) {
    const row = await prisma.template.findUniqueOrThrow({ where: { id } });
    startersBefore.set(id, canonical(row));
  }
  pass(`captured ${STARTER_IDS.length} starter rows (five original + UTILITY) for a byte-identical check at the end`);

  console.log('\nSetting up merchant A and merchant B, each with their own template + bill...');
  const merchantA = await createScratchSession();
  const merchantB = await createScratchSession();
  const templateA = await createOwnTemplate(merchantA, 'X-4 merchant A template', true);
  const templateB = await createOwnTemplate(merchantB, 'X-4 merchant B template', true);
  // A second, non-default template for B — needed for the restore probe below
  // (archiving the current default is refused, so this one is archived instead).
  const templateB2 = await createOwnTemplate(merchantB, 'X-4 merchant B second template', false);
  const billA = await billsService.createBill(buildBillDto(templateA.id, `a-${Date.now()}`), merchantA.merchantId);
  const billB = await billsService.createBill(buildBillDto(templateB.id, `b-${Date.now()}`), merchantB.merchantId);
  console.log(`   merchant A: ${merchantA.merchantId} (template ${templateA.id}, bill ${billA.body.bill_id})`);
  console.log(`   merchant B: ${merchantB.merchantId} (template ${templateB.id}, extra ${templateB2.id}, bill ${billB.body.bill_id})\n`);

  try {
    // ================= Part 1: cross-merchant probe, every id-taking route =================
    console.log("--- Part 1: every id-taking /portal route, asked for merchant B's resource while authenticated as A ---\n");

    // -- GET /portal/bills/:id
    {
      const res = await fetch(`${API_BASE}/portal/bills/${billB.body.bill_id}`, { headers: { cookie: cookie(merchantA) } });
      if (res.status !== 404) findingFail(`GET /portal/bills/:id — expected 404 for B's bill as A, got ${res.status}`);
      pass('GET /portal/bills/:id -> 404');
    }

    // -- GET /portal/templates/:id
    {
      const res = await fetch(`${API_BASE}/portal/templates/${templateB.id}`, { headers: { cookie: cookie(merchantA) } });
      if (res.status !== 404) findingFail(`GET /portal/templates/:id — expected 404 for B's template as A, got ${res.status}`);
      pass('GET /portal/templates/:id -> 404');
    }

    // -- POST .../save — 404-on-mutate + re-SELECT proving zero write.
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
      pass('POST .../save -> 404, re-SELECT confirms zero write (row + count unchanged)');
    }

    // -- POST .../save-as (F-2) — 404-on-mutate: source lookup is out of A's OR-null scope.
    {
      const beforeCount = await prisma.template.count({ where: { merchantId: merchantA.merchantId } });
      const token = await csrfToken(merchantA);
      const res = await fetch(`${API_BASE}/portal/templates/${templateB.id}/save-as`, {
        method: 'POST',
        headers: { cookie: cookie(merchantA), 'x-csrf-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'x4 probe', layoutSchema: { blocks: [] } }),
      });
      if (res.status !== 404) findingFail(`POST .../save-as — expected 404 for B's template as A, got ${res.status}`);
      const afterCount = await prisma.template.count({ where: { merchantId: merchantA.merchantId } });
      if (afterCount !== beforeCount) findingFail(`POST .../save-as on B's template as A -> 404, but a row was created under A anyway (${beforeCount} -> ${afterCount})`);
      pass('POST .../save-as -> 404, re-SELECT confirms zero write');
    }

    // -- POST .../set-default — 404-on-mutate, A's OWN default pointers untouched.
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
      pass("POST .../set-default -> 404, A's own default pointers unchanged");
    }

    // -- POST .../archive — 404-on-mutate, B's template archivedAt untouched.
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
      pass("POST .../archive -> 404, B's template archivedAt unchanged");
    }

    // -- POST .../restore (F-5, NEW this phase) — archive B's SECOND template as
    // B (real HTTP), then attempt restore as A -> 404, re-SELECT confirms it is
    // still archived (D-75 scoping + D-47 tenancy, together).
    {
      const tokenB = await csrfToken(merchantB);
      const archiveRes = await fetch(`${API_BASE}/portal/templates/${templateB2.id}/archive`, {
        method: 'POST',
        headers: { cookie: cookie(merchantB), 'x-csrf-token': tokenB },
      });
      if (archiveRes.status !== 201 && archiveRes.status !== 200) findingFail(`setup: B archiving its own second template failed: HTTP ${archiveRes.status}`);
      const archived = await prisma.template.findUniqueOrThrow({ where: { id: templateB2.id } });
      if (!archived.archivedAt) findingFail('setup: B\'s second template did not actually get archived');

      const tokenA = await csrfToken(merchantA);
      const res = await fetch(`${API_BASE}/portal/templates/${templateB2.id}/restore`, {
        method: 'POST',
        headers: { cookie: cookie(merchantA), 'x-csrf-token': tokenA },
      });
      if (res.status !== 404) findingFail(`POST .../restore — expected 404 for B's archived template as A, got ${res.status}`);
      const after = await prisma.template.findUniqueOrThrow({ where: { id: templateB2.id } });
      if (after.archivedAt === null) findingFail("POST .../restore on B's template as A -> 404, but it got restored anyway");
      if (after.name !== archived.name) findingFail("POST .../restore on B's template as A -> 404, but its name changed anyway");
      pass("POST .../restore -> 404, B's archived template stays archived under its own name");
    }

    // -- DELETE /portal/templates/:id (F-4) — 404-on-delete, B's template still there.
    {
      const beforeCount = await prisma.template.count({ where: { merchantId: merchantB.merchantId } });
      const token = await csrfToken(merchantA);
      const res = await fetch(`${API_BASE}/portal/templates/${templateB.id}`, {
        method: 'DELETE',
        headers: { cookie: cookie(merchantA), 'x-csrf-token': token },
      });
      if (res.status !== 404) findingFail(`DELETE .../templates/:id — expected 404 for B's template as A, got ${res.status}`);
      await prisma.template.findUniqueOrThrow({ where: { id: templateB.id } });
      const afterCount = await prisma.template.count({ where: { merchantId: merchantB.merchantId } });
      if (afterCount !== beforeCount) findingFail(`DELETE on B's template as A -> 404, but B's template count changed (${beforeCount} -> ${afterCount})`);
      pass("DELETE /portal/templates/:id -> 404, B's template untouched");
    }

    // -- POST .../resend (R-2, NEW this phase) — 404-on-mutate, zero new Broadcast
    // rows on B's order.
    {
      const billBOrder = await prisma.bill.findUniqueOrThrow({ where: { id: billB.body.bill_id }, select: { orderId: true } });
      const beforeCount = await prisma.broadcast.count({ where: { orderId: billBOrder.orderId } });
      const res = await fetch(`${API_BASE}/portal/bills/${billB.body.bill_id}/resend`, {
        method: 'POST',
        headers: { cookie: cookie(merchantA) }, // no @Body per D-79 — no CSRF-relevant payload either way, header still required
      });
      // Note: resend has no @Body but is still a mutating /portal route — CSRF applies.
      if (res.status === 403) {
        // If CsrfGuard fired before the 404 tenancy check, retry with a real token
        // to isolate the tenancy assertion specifically (CSRF is D-57's own concern).
        const token = await csrfToken(merchantA);
        const retry = await fetch(`${API_BASE}/portal/bills/${billB.body.bill_id}/resend`, {
          method: 'POST',
          headers: { cookie: cookie(merchantA), 'x-csrf-token': token },
        });
        if (retry.status !== 404) findingFail(`POST .../resend — expected 404 for B's bill as A, got ${retry.status}`);
      } else if (res.status !== 404) {
        findingFail(`POST .../resend — expected 404 for B's bill as A, got ${res.status}`);
      }
      const afterCount = await prisma.broadcast.count({ where: { orderId: billBOrder.orderId } });
      if (afterCount !== beforeCount) findingFail(`POST .../resend on B's bill as A -> 404, but a new Broadcast row appeared under B's order anyway (${beforeCount} -> ${afterCount})`);
      pass("POST .../resend -> 404, zero new Broadcast rows on B's order");
    }

    console.log('');

    // ================= Part 2: F-7/D-61 cross-merchant template_id fallback =================
    console.log('--- Part 2: POST /v1/bills — another merchant\'s template_id falls back per D-61, never 403, never renders their template ---\n');
    {
      const result = await billsService.createBill(
        buildBillDto(templateB.id, `f7-cross-${Date.now()}`),
        merchantA.merchantId,
      );
      if (!result.created) findingFail('POST /v1/bills with a cross-merchant template_id did not create a bill (D-61 says fall back, not fail)');
      const fallback = result.body.template_fallback;
      if (!fallback || fallback.reason !== 'TEMPLATE_ID_NOT_FOUND') {
        findingFail(`expected template_fallback.reason === 'TEMPLATE_ID_NOT_FOUND', got ${JSON.stringify(fallback)}`);
      }
      if (fallback.requested_template_id !== templateB.id) {
        findingFail(`expected template_fallback.requested_template_id === ${templateB.id}, got ${fallback.requested_template_id}`);
      }
      if (result.body.template_id_used !== templateA.id) {
        findingFail(`expected template_id_used === A's own default (${templateA.id}), got ${result.body.template_id_used} — B's template must never be used`);
      }
      const dbBill = await prisma.bill.findUniqueOrThrow({ where: { id: result.body.bill_id }, select: { templateId: true } });
      if (dbBill.templateId !== templateA.id) findingFail(`the bill's own DB row was rendered from ${dbBill.templateId}, not A's default ${templateA.id}`);
      pass("POST /v1/bills with merchant B's template_id -> 201, falls back to A's own default (D-61), never B's template, never a 403");
    }
    console.log('');

    // ================= Part 3: full lifecycle sequence against one live bill's template =================
    console.log('--- Part 3: §7 immutability — edit x3, rename, Save As, archive, restore — all against ONE live bill\'s template, over real HTTP ---\n');

    const merchantC = await createScratchSession();
    try {
      // Step 0: Save As from the shared starter, over real HTTP (F-2), with the
      // starter's OWN document (no edits yet — a clean fork to build the
      // lineage the bill will be created against).
      const presetBefore = await prisma.template.findUniqueOrThrow({ where: { id: SOURCE_PRESET_ID } });
      const presetDoc = presetBefore.layoutSchema as { blocks: unknown[]; theme?: unknown };
      let token = await csrfToken(merchantC);
      const setupRes = await fetch(`${API_BASE}/portal/templates/${SOURCE_PRESET_ID}/save-as`, {
        method: 'POST',
        headers: { cookie: cookie(merchantC), 'x-csrf-token': token, 'content-type': 'application/json' },
        body: JSON.stringify({ name: `x4 scratch ${Date.now()}`, layoutSchema: { blocks: presetDoc.blocks, ...(presetDoc.theme ? { theme: presetDoc.theme } : {}) } }),
      });
      if (setupRes.status !== 201) findingFail(`real HTTP save-as (setup) failed: HTTP ${setupRes.status}: ${await setupRes.text()}`);
      const cloned = (await setupRes.json()) as { id: string; merchantId: string };
      if (cloned.merchantId !== merchantC.merchantId) findingFail(`save-as produced merchantId=${cloned.merchantId}, expected ${merchantC.merchantId}`);
      pass(`real HTTP save-as (setup) — new merchant-owned template ${cloned.id}`);

      // Step 1: create a real bill against it, via the real direct-API write path.
      const createResult = await billsService.createBill(buildBillDto(cloned.id, `c-${Date.now()}`), merchantC.merchantId);
      if (!createResult.created) findingFail('createBill() reported created:false on a fresh external_transaction_id');
      const identifier = createResult.body.identifier;
      const billRow = await prisma.bill.findUniqueOrThrow({ where: { id: createResult.body.bill_id }, select: { layoutSnapshot: true } });
      const originalCanonical = canonical(billRow.layoutSnapshot);
      pass(`createBill() — real bill ${createResult.body.bill_id}, link ${identifier}, snapshot captured`);

      async function assertBillUnchanged(step: string): Promise<void> {
        const after = await prisma.bill.findUniqueOrThrow({ where: { id: createResult.body.bill_id }, select: { layoutSnapshot: true } });
        if (canonical(after.layoutSnapshot) !== originalCanonical) {
          findingFail(`Bill.layoutSnapshot changed after ${step} — §7 immutability violated`);
        }
        const resolved = await linksService.resolve(identifier);
        if (canonical(resolved.bill.layoutSnapshot) !== originalCanonical) {
          findingFail(`LinksService.resolve() changed after ${step}`);
        }
        pass(`Bill.layoutSnapshot + resolve() byte-unchanged after ${step}`);
      }

      // Steps 2-4: three real-HTTP builder edits (fork-on-write via save()).
      const edits: Array<(blocks: unknown[]) => unknown[]> = [
        (blocks) => blocks.map((b) => ((b as { type: string }).type === 'LOYALTY' ? { ...(b as object), visible: false } : b)),
        (blocks) =>
          blocks.map((b) =>
            (b as { type: string }).type === 'COUPON'
              ? { ...(b as { props: object }), props: { ...(b as { props: object }).props, headline: 'X-4 verification edit' } }
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

        token = await csrfToken(merchantC);
        const res = await fetch(`${API_BASE}/portal/templates/${headId}/save`, {
          method: 'POST',
          headers: { cookie: cookie(merchantC), 'x-csrf-token': token, 'content-type': 'application/json' },
          body: JSON.stringify({ layoutSchema: { blocks: editedBlocks } }),
        });
        if (res.status !== 201) findingFail(`real HTTP save() edit #${n} failed: HTTP ${res.status}: ${await res.text()}`);
        const forked = (await res.json()) as { id: string };
        pass(`real HTTP save() edit #${n} — forked ${headId} -> ${forked.id}`);
        headId = forked.id;
        await assertBillUnchanged(`save() edit #${n}`);
      }

      // Step 5: RENAME via save() with `name` (F-1) — in-place rename semantics,
      // still one list entry.
      {
        const headBefore = await prisma.template.findUniqueOrThrow({ where: { id: headId } });
        const doc = headBefore.layoutSchema as { blocks: unknown[] };
        const newName = `${headBefore.name} renamed`;
        token = await csrfToken(merchantC);
        const res = await fetch(`${API_BASE}/portal/templates/${headId}/save`, {
          method: 'POST',
          headers: { cookie: cookie(merchantC), 'x-csrf-token': token, 'content-type': 'application/json' },
          body: JSON.stringify({ layoutSchema: { blocks: doc.blocks }, name: newName }),
        });
        if (res.status !== 201) findingFail(`real HTTP save() rename failed: HTTP ${res.status}: ${await res.text()}`);
        const forked = (await res.json()) as { id: string; name: string };
        if (forked.name !== newName) findingFail(`rename via save() produced name=${forked.name}, expected ${newName}`);
        const list = await prisma.template.count({ where: { merchantId: merchantC.merchantId, isHead: true, archivedAt: null } });
        pass(`real HTTP save() rename — forked ${headId} -> ${forked.id}, name="${forked.name}", ${list} live head row(s) for C`);
        headId = forked.id;
        await assertBillUnchanged('rename via save()');
      }

      // Step 6: SAVE AS (F-2) from the current head — a clean-break copy into a
      // NEW lineage. Must not touch the source (still the bill's real lineage
      // head) or the bill.
      {
        const sourceBefore = await prisma.template.findUniqueOrThrow({ where: { id: headId } });
        const doc = sourceBefore.layoutSchema as { blocks: unknown[] };
        const editedBlocks = doc.blocks.map((b) =>
          (b as { type: string }).type === 'COUPON' ? { ...(b as { props: object }), props: { ...(b as { props: object }).props, headline: 'X-4 save-as branch' } } : b,
        );
        token = await csrfToken(merchantC);
        const res = await fetch(`${API_BASE}/portal/templates/${headId}/save-as`, {
          method: 'POST',
          headers: { cookie: cookie(merchantC), 'x-csrf-token': token, 'content-type': 'application/json' },
          body: JSON.stringify({ name: `x4 save-as branch ${Date.now()}`, layoutSchema: { blocks: editedBlocks } }),
        });
        if (res.status !== 201) findingFail(`real HTTP save-as failed: HTTP ${res.status}: ${await res.text()}`);
        const branch = (await res.json()) as { id: string; parentTemplateId: string | null };
        if (branch.parentTemplateId !== null) findingFail(`save-as produced parentTemplateId=${branch.parentTemplateId}, expected null (clean break, D-62)`);

        const sourceAfter = await prisma.template.findUniqueOrThrow({ where: { id: headId } });
        if (canonical(sourceAfter) !== canonical(sourceBefore)) {
          findingFail('save-as mutated the source row it was called on — D-62 violated');
        }
        const branchRow = await prisma.template.findUniqueOrThrow({ where: { id: branch.id } });
        const branchDoc = branchRow.layoutSchema as { blocks: unknown[] };
        if (canonical(branchDoc.blocks) !== canonical(editedBlocks)) {
          findingFail('save-as persisted something other than the EDITED body it was given — D-62 violated');
        }
        pass(`real HTTP save-as — new independent lineage ${branch.id}, source ${headId} byte-identical, edited body persisted verbatim`);
        await assertBillUnchanged('save-as (side branch)');
      }

      // Step 7: ARCHIVE the bill's real lineage head (F-5/D-33).
      {
        token = await csrfToken(merchantC);
        const res = await fetch(`${API_BASE}/portal/templates/${headId}/archive`, {
          method: 'POST',
          headers: { cookie: cookie(merchantC), 'x-csrf-token': token },
        });
        if (res.status !== 201 && res.status !== 200) findingFail(`real HTTP archive failed: HTTP ${res.status}: ${await res.text()}`);
        const row = await prisma.template.findUniqueOrThrow({ where: { id: headId } });
        if (!row.archivedAt) findingFail('archive() did not set archivedAt');
        if (!row.isHead) findingFail('archive() changed isHead — D-65 says an archived row keeps isHead');
        pass(`real HTTP archive() — ${headId} archived, isHead retained (D-65)`);
        await assertBillUnchanged('archive()');
      }

      // Step 8: RESTORE (F-5/D-65) — clears archivedAt, same row (no fork).
      {
        token = await csrfToken(merchantC);
        const res = await fetch(`${API_BASE}/portal/templates/${headId}/restore`, {
          method: 'POST',
          headers: { cookie: cookie(merchantC), 'x-csrf-token': token },
        });
        if (res.status !== 201 && res.status !== 200) findingFail(`real HTTP restore failed: HTTP ${res.status}: ${await res.text()}`);
        const restored = (await res.json()) as { id: string };
        if (restored.id !== headId) findingFail(`restore() returned a different row id (${restored.id}) than the one archived (${headId}) — D-65 says restore clears archivedAt in place, no fork`);
        const row = await prisma.template.findUniqueOrThrow({ where: { id: headId } });
        if (row.archivedAt !== null) findingFail('restore() did not clear archivedAt');
        pass(`real HTTP restore() — ${headId} restored in place (same row id, no fork)`);
        await assertBillUnchanged('restore()');
      }

      const finalResolved = await linksService.resolve(identifier);
      if (canonical(finalResolved.bill.layoutSnapshot) !== originalCanonical) {
        findingFail('final resolve() does not match the originally frozen layoutSnapshot after the full lifecycle sequence');
      }
      pass('final resolve() — rendered blocks match the original, unedited layout after edit x3 + rename + Save As + archive + restore\n');

      // ============ Part 4: D-72 — Save As from the UTILITY starter is a named 422 ============
      console.log('--- Part 4: Save As from seed-template-utility -> 422 INVALID_LAYOUT_SCHEMA (D-72), zero writes ---\n');
      {
        const utilityRow = await prisma.template.findUniqueOrThrow({ where: { id: UTILITY_STARTER_ID } });
        const utilityDoc = utilityRow.layoutSchema as { blocks: unknown[] };
        const beforeCount = await prisma.template.count({ where: { merchantId: merchantC.merchantId } });
        token = await csrfToken(merchantC);
        const res = await fetch(`${API_BASE}/portal/templates/${UTILITY_STARTER_ID}/save-as`, {
          method: 'POST',
          headers: { cookie: cookie(merchantC), 'x-csrf-token': token, 'content-type': 'application/json' },
          body: JSON.stringify({ name: `x4 utility attempt ${Date.now()}`, layoutSchema: { blocks: utilityDoc.blocks } }),
        });
        if (res.status !== 422) findingFail(`Save As from seed-template-utility -> expected 422, got ${res.status}`);
        const body = (await res.json()) as { error_code?: string; issues?: unknown };
        if (body.error_code !== 'INVALID_LAYOUT_SCHEMA') findingFail(`expected error_code INVALID_LAYOUT_SCHEMA, got ${JSON.stringify(body.error_code)}`);
        const issuesStr = JSON.stringify(body.issues ?? '');
        if (!/ITEMS/.test(issuesStr) || !/CHARGES/.test(issuesStr)) {
          findingFail(`D-72 requires D-31's rule verbatim ("A visible ITEMS or CHARGES block is required") in the issue message; got: ${issuesStr}`);
        }
        const afterCount = await prisma.template.count({ where: { merchantId: merchantC.merchantId } });
        if (afterCount !== beforeCount) findingFail(`Save As from UTILITY starter -> 422, but a row was created anyway (${beforeCount} -> ${afterCount})`);
        pass('Save As from seed-template-utility -> 422 INVALID_LAYOUT_SCHEMA carrying D-31\'s rule verbatim, zero writes\n');
      }
    } finally {
      await cleanupMerchant(merchantC);
    }

    // ================= Part 5: STORE_STAFF role gate — the one A-6 write-sweep gap =================
    console.log("--- Part 5: real STORE_STAFF login (A-6's principal) — export.csv is MERCHANT_ADMIN only, was not in A-6's write-sweep ---\n");
    {
      const { jar, finalStatus } = await driveRealLogin(STORE_STAFF_SUBJECT);
      if (finalStatus !== 200) findingFail(`real STORE_STAFF login did not complete (final status ${finalStatus})`);
      const before = await prisma.piiExportAudit.count();
      const res = await fetch(`${API_BASE}/portal/bills/export.csv?contact=masked`, { headers: { cookie: cookieHeader(jar) } });
      const after = await prisma.piiExportAudit.count();
      if (res.status !== 403) findingFail(`STORE_STAFF GET /portal/bills/export.csv -> expected 403, got ${res.status}`);
      if (after !== before) findingFail(`STORE_STAFF's refused export.csv attempt wrote a PiiExportAudit row anyway (${before} -> ${after}) — D-71 violated`);
      pass('STORE_STAFF GET /portal/bills/export.csv?contact=masked -> 403, zero PiiExportAudit rows written');

      const resFull = await fetch(`${API_BASE}/portal/bills/export.csv?contact=full`, { headers: { cookie: cookieHeader(jar) } });
      if (resFull.status !== 403) findingFail(`STORE_STAFF GET /portal/bills/export.csv?contact=full -> expected 403, got ${resFull.status}`);
      pass('STORE_STAFF GET /portal/bills/export.csv?contact=full -> 403 (both projections refused, D-71)\n');
    }

    console.log('=== X-4: all checks passed — full Phase-5 /portal surface probed cross-merchant, lifecycle immutability holds, six starters intact ===\n');
  } finally {
    await cleanupMerchant(merchantA);
    await cleanupMerchant(merchantB);

    const templateCountAfter = await prisma.template.count();
    if (templateCountAfter !== templateCountBefore) {
      console.error(
        `\n=== X-4 FINDING ===\nTemplate row count changed across this run: ${templateCountBefore} -> ${templateCountAfter} — ` +
          'a scratch lineage leaked past cleanup\n===================\n',
      );
      process.exitCode = 1;
    } else {
      pass(`Template row count unchanged across the run (${templateCountBefore})`);
    }

    const auditCountAfter = await prisma.piiExportAudit.count();
    if (auditCountAfter !== auditCountBefore) {
      console.error(
        `\n=== X-4 FINDING ===\nPiiExportAudit row count changed across this run: ${auditCountBefore} -> ${auditCountAfter} — ` +
          'an audit row was written where none should have been\n===================\n',
      );
      process.exitCode = 1;
    } else {
      pass(`PiiExportAudit row count unchanged across the run (${auditCountBefore})`);
    }

    // Part 6 (final): all six starters byte-identical after the full session.
    let starterMismatch = false;
    for (const id of STARTER_IDS) {
      const row = await prisma.template.findUniqueOrThrow({ where: { id } });
      const now = canonical(row);
      if (now !== startersBefore.get(id)) {
        console.error(`\n=== X-4 FINDING ===\nStarter ${id} changed across this run — starter immutability violated\n===================\n`);
        starterMismatch = true;
      }
    }
    if (!starterMismatch) {
      pass(`all ${STARTER_IDS.length} starters (five original + UTILITY) byte-identical after the full multi-merchant session`);
    } else {
      process.exitCode = 1;
    }

    await prisma.$disconnect();
    await prismaService.$disconnect();
  }
}

main().catch(async (err) => {
  console.error('\nverify-x4-final-regression crashed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
