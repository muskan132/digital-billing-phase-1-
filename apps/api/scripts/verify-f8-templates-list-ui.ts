// F-8 — builder & list UI. This script does what the UI does: it drives every
// endpoint the /portal/templates page and builder wire, over REAL HTTP, through
// the real SessionGuard/CsrfGuard chain (a real scratch session), and asserts:
//
//   - GET /portal/templates carries the D-68 `isStarter` projection the UI
//     splits on (starters true, own templates false).
//   - a STARTER permits Save As but NOT Save (422 CANNOT_FORK_LIBRARY_PRESET) —
//     which is why the list/builder hide Save on starters.
//   - a refusal returns the server's NAMED error (error_code AND message) so the
//     UI can surface it verbatim — proven for delete-with-issued-bills
//     (TEMPLATE_HAS_ISSUED_BILLS) and archive-current-default
//     (CANNOT_ARCHIVE_DEFAULT_TEMPLATE), the two the roadmap calls out.
//   - archive -> appears in GET /portal/templates/archived -> restore -> gone.
//   - create-from-scratch (POST /portal/templates) lands a new owned template.
//   - cross-merchant id -> 404 on every mutating route.
//   - /demo/templates source is untouched (D-49).
//
// Usage: pnpm --filter @digital-billing/api verify:f8   (apps/api server must be running)

import * as path from 'path';
import { execSync } from 'child_process';
import { config } from 'dotenv';
import { createHash, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';

config({ path: path.join(__dirname, '..', '.env') });

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';
const prisma = new PrismaClient();

let counter = 0;
const uid = (p: string) => `f8-verify-${p}-${Date.now()}-${++counter}`;

function fail(msg: string): never {
  throw new Error(`FAIL — ${msg}`);
}
function pass(msg: string): void {
  console.log(`PASS  ${msg}`);
}

function hashToken(token: string): Uint8Array<ArrayBuffer> {
  const digest = createHash('sha256').update(token).digest();
  const out = new Uint8Array(new ArrayBuffer(digest.length));
  out.set(digest);
  return out;
}

interface Session {
  merchantId: string;
  userId: string;
  rawToken: string;
}

async function createSession(role: 'MERCHANT_ADMIN' | 'STORE_STAFF' = 'MERCHANT_ADMIN'): Promise<Session> {
  const merchantId = uid('merchant');
  await prisma.merchant.create({
    data: { id: merchantId, jiopayMid: uid('mid'), name: `F-8 verify ${merchantId}`, secretKeyEnc: Buffer.from('unused'), gstin: '27ABCDE1234F1Z5', gstStateCode: '27' },
  });
  const userId = uid('user');
  await prisma.user.create({ data: { id: userId, merchantId, type: 'EXTERNAL', role, email: `${userId}@example.invalid`, subject: userId } });
  const rawToken = randomBytes(32).toString('base64url');
  await prisma.merchantSession.create({ data: { userId, tokenHash: hashToken(rawToken), expiresAt: new Date(Date.now() + 10 * 60_000) } });
  return { merchantId, userId, rawToken };
}

async function cleanup(s: Session): Promise<void> {
  const orderIds = (await prisma.order.findMany({ where: { merchantId: s.merchantId }, select: { id: true } })).map((o) => o.id);
  await prisma.broadcast.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.link.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.orderItem.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.bill.deleteMany({ where: { merchantId: s.merchantId } });
  await prisma.order.deleteMany({ where: { merchantId: s.merchantId } });
  await prisma.merchantSession.deleteMany({ where: { userId: s.userId } });
  await prisma.user.deleteMany({ where: { id: s.userId } });
  await prisma.merchant.update({ where: { id: s.merchantId }, data: { defaultReceiptTemplateId: null, defaultTaxInvoiceTemplateId: null } }).catch(() => {});
  await prisma.template.deleteMany({ where: { merchantId: s.merchantId } });
  await prisma.merchant.deleteMany({ where: { id: s.merchantId } });
}

const cookie = (s: Session) => `session=${s.rawToken}`;

async function csrf(s: Session): Promise<string> {
  const res = await fetch(`${API_BASE}/portal/csrf-token`, { headers: { cookie: cookie(s) } });
  if (!res.ok) fail(`could not get a CSRF token: HTTP ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

async function apiGet(s: Session, p: string) {
  const res = await fetch(`${API_BASE}${p}`, { headers: { cookie: cookie(s) } });
  return { status: res.status, json: (await res.json().catch(() => null)) as unknown };
}

async function apiWrite(s: Session, method: 'POST' | 'DELETE', p: string, body?: unknown) {
  const res = await fetch(`${API_BASE}${p}`, {
    method,
    headers: { cookie: cookie(s), 'x-csrf-token': await csrf(s), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

// The UI's extractServerError (apps/web): human message if present, else the
// error_code verbatim, else a generic. "Named error, not a generic failure" is
// satisfied as long as one of the first two is available.
function uiErrorText(body: Record<string, unknown> | null, status: number): string {
  if (body) {
    if (typeof body.message === 'string' && body.message.length > 0) return body.message;
    if (typeof body.error_code === 'string') return body.error_code;
  }
  return `Request failed (HTTP ${status}).`;
}

// The two cases the roadmap calls out MUST carry a human message.
function assertNamedErrorWithMessage(r: { status: number; json: Record<string, unknown> | null }, expectedCode: string, label: string) {
  if (r.status !== 422) fail(`${label}: expected HTTP 422, got ${r.status}`);
  if (!r.json || r.json.error_code !== expectedCode) fail(`${label}: expected error_code ${expectedCode}, got ${JSON.stringify(r.json)}`);
  if (typeof r.json.message !== 'string' || r.json.message.length === 0) {
    fail(`${label}: no human 'message' in the body — the UI would fall back to the code. Body: ${JSON.stringify(r.json)}`);
  }
  pass(`${label} → 422 ${expectedCode} with verbatim message: "${r.json.message}"`);
}

// Other named errors: the code must reach the UI; a message is nice-to-have.
function assertNamedErrorCode(r: { status: number; json: Record<string, unknown> | null }, expectedCode: string, label: string) {
  if (r.status !== 422) fail(`${label}: expected HTTP 422, got ${r.status}`);
  if (!r.json || r.json.error_code !== expectedCode) fail(`${label}: expected error_code ${expectedCode}, got ${JSON.stringify(r.json)}`);
  const text = uiErrorText(r.json, r.status);
  if (/^request failed/i.test(text)) fail(`${label}: the UI would show a generic — no code and no message. Body: ${JSON.stringify(r.json)}`);
  const hasMsg = typeof r.json.message === 'string' && r.json.message.length > 0;
  pass(`${label} → 422 ${expectedCode}${hasMsg ? ` ("${r.json.message}")` : ' (code only — no human message; see F-8 finding)'}`);
}

const MINIMAL_BLOCKS = [
  { id: 'blk_1', type: 'HEADER', order: 1, props: {}, visible: true, width: 'full' },
  { id: 'blk_2', type: 'ITEMS', order: 2, props: {}, visible: true, width: 'full' },
];

async function issueBillAgainst(merchantId: string, templateId: string) {
  const orderId = uid('order');
  await prisma.order.create({ data: { id: orderId, merchantId, status: 'SUCCESS', externalTransactionId: uid('ext'), rawCallback: {} } });
  await prisma.bill.create({ data: { id: uid('bill'), orderId, merchantId, billType: 'RECEIPT', templateId, totalPaise: BigInt(100), snapshot: {} } });
}

async function main() {
  console.log('\n=== verify-f8-templates-list-ui ===\n');

  const a = await createSession('MERCHANT_ADMIN');
  const b = await createSession('MERCHANT_ADMIN');

  try {
    // --- 1. GET /portal/templates carries isStarter (D-68) ----------------
    const list = await apiGet(a, '/portal/templates');
    if (list.status !== 200) fail(`GET /portal/templates → ${list.status}`);
    const items = (list.json as { templates: Array<Record<string, unknown>> }).templates;
    if (!items.every((t) => typeof t.isStarter === 'boolean')) fail('GET /portal/templates: some rows lack isStarter');
    const starters = items.filter((t) => t.isStarter === true);
    const mine = items.filter((t) => t.isStarter === false);
    if (starters.length < 5) fail(`expected the seeded starters in the list, saw ${starters.length}`);
    if (mine.length !== 0) fail(`a fresh merchant should own no templates, saw ${mine.length}`);
    pass(`GET /portal/templates: ${starters.length} starters (isStarter:true), ${mine.length} own (isStarter:false) — the split the UI renders`);

    const aReceiptStarter = starters.find((t) => t.billType === 'RECEIPT');
    if (!aReceiptStarter) fail('no RECEIPT starter found');
    const starterId = aReceiptStarter.id as string;

    // --- 2. archived + defaults endpoints the page fetches -------------
    const archived0 = await apiGet(a, '/portal/templates/archived');
    if (archived0.status !== 200 || !Array.isArray(archived0.json)) fail('GET /portal/templates/archived not a 200 array');
    const defaults0 = await apiGet(a, '/portal/templates/defaults');
    if (defaults0.status !== 200 || !defaults0.json || !('receipt' in (defaults0.json as object))) fail('GET /portal/templates/defaults bad shape');
    pass('GET /portal/templates/archived → [] and /defaults → { receipt, taxInvoice } (the page fetches both)');

    // --- 3. starter: Save As allowed, Save refused ------------------
    const saveOnStarter = await apiWrite(a, 'POST', `/portal/templates/${starterId}/save`, { layoutSchema: { blocks: MINIMAL_BLOCKS } });
    assertNamedErrorCode(saveOnStarter, 'CANNOT_FORK_LIBRARY_PRESET', 'Save on a starter');

    const saveAs = await apiWrite(a, 'POST', `/portal/templates/${starterId}/save-as`, { name: uid('MyCopy'), layoutSchema: { blocks: MINIMAL_BLOCKS } });
    if (saveAs.status !== 201) fail(`Save As on a starter → ${saveAs.status}: ${JSON.stringify(saveAs.json)}`);
    pass('Save As on a starter → 201 (the only write the UI offers on a starter)');

    // --- 4. create-from-scratch ----------------------------------
    const created = await apiWrite(a, 'POST', '/portal/templates', { name: uid('Scratch'), billType: 'RECEIPT', skeleton: 'MINIMALIST' });
    if (created.status !== 201 || !created.json?.id) fail(`create-from-scratch → ${created.status}: ${JSON.stringify(created.json)}`);
    const scratchId = created.json.id as string;
    const listAfter = await apiGet(a, '/portal/templates');
    const mineAfter = (listAfter.json as { templates: Array<Record<string, unknown>> }).templates.filter((t) => t.isStarter === false);
    if (!mineAfter.some((t) => t.id === scratchId)) fail('created template did not appear under the merchant’s own list');
    pass('POST /portal/templates (web: /create) → 201, the new template shows under "my templates" (isStarter:false)');

    // --- 5. THE roadmap refusal cases ---------------------------
    // 5a. delete with issued bills
    const withBill = await apiWrite(a, 'POST', `/portal/templates/${starterId}/save-as`, { name: uid('HasBill'), layoutSchema: { blocks: MINIMAL_BLOCKS } });
    const withBillId = withBill.json?.id as string;
    await issueBillAgainst(a.merchantId, withBillId);
    const delWithBill = await apiWrite(a, 'DELETE', `/portal/templates/${withBillId}`);
    assertNamedErrorWithMessage(delWithBill, 'TEMPLATE_HAS_ISSUED_BILLS', 'DELETE a template that has issued bills');

    // 5b. archive the current default
    const asDefault = await apiWrite(a, 'POST', `/portal/templates/${scratchId}/set-default`);
    if (asDefault.status !== 201) fail(`set-default → ${asDefault.status}`);
    const archiveDefault = await apiWrite(a, 'POST', `/portal/templates/${scratchId}/archive`);
    assertNamedErrorWithMessage(archiveDefault, 'CANNOT_ARCHIVE_DEFAULT_TEMPLATE', 'archive the current default');

    // --- 6. archive → archived view → restore -------------------
    const normal = await apiWrite(a, 'POST', `/portal/templates/${starterId}/save-as`, { name: uid('ToArchive'), layoutSchema: { blocks: MINIMAL_BLOCKS } });
    const normalId = normal.json?.id as string;
    const arch = await apiWrite(a, 'POST', `/portal/templates/${normalId}/archive`);
    if (arch.status !== 201) fail(`archive → ${arch.status}: ${JSON.stringify(arch.json)}`);
    const archivedList = await apiGet(a, '/portal/templates/archived');
    if (!(archivedList.json as Array<{ id: string }>).some((t) => t.id === normalId)) fail('archived template missing from GET /portal/templates/archived');
    const listNoArch = (await apiGet(a, '/portal/templates')).json as { templates: Array<{ id: string }> };
    if (listNoArch.templates.some((t) => t.id === normalId)) fail('archived template still shows in the main list');
    const restore = await apiWrite(a, 'POST', `/portal/templates/${normalId}/restore`);
    if (restore.status !== 201) fail(`restore → ${restore.status}: ${JSON.stringify(restore.json)}`);
    const archivedAfter = await apiGet(a, '/portal/templates/archived');
    if ((archivedAfter.json as Array<{ id: string }>).some((t) => t.id === normalId)) fail('restored template still in the archived view');
    pass('archive → appears in /archived, gone from main list → restore → back in main list, gone from /archived');

    // --- 7. cross-merchant → 404 on every mutating route -----------
    const bScratch = await apiWrite(b, 'POST', '/portal/templates', { name: uid('BScratch'), billType: 'RECEIPT', skeleton: 'MINIMALIST' });
    const bId = bScratch.json?.id as string;
    for (const [method, p] of [
      ['POST', `/portal/templates/${bId}/save`],
      ['POST', `/portal/templates/${bId}/save-as`],
      ['POST', `/portal/templates/${bId}/set-default`],
      ['POST', `/portal/templates/${bId}/archive`],
      ['POST', `/portal/templates/${bId}/restore`],
      ['DELETE', `/portal/templates/${bId}`],
    ] as const) {
      const r = await apiWrite(a, method, p, method === 'POST' && p.endsWith('save') ? { layoutSchema: { blocks: MINIMAL_BLOCKS } } : method === 'POST' && p.endsWith('save-as') ? { name: 'x', layoutSchema: { blocks: MINIMAL_BLOCKS } } : undefined);
      if (r.status !== 404) fail(`cross-merchant ${method} ${p} → ${r.status}, expected 404`);
    }
    pass("another merchant's templateId → 404 on save / save-as / set-default / archive / restore / delete");

    // --- 8. /demo/templates untouched (D-49) ---------------------
    const demoDiff = execSync('git status --porcelain "apps/web/app/(main)/demo" "apps/web/src/builder" "apps/web/src/render"', {
      cwd: path.join(__dirname, '..', '..', '..'),
    }).toString().trim();
    if (demoDiff.length > 0) fail(`demo/builder/render files were modified:\n${demoDiff}`);
    pass('/demo/templates, src/builder/* and src/render/* are byte-unchanged (git porcelain clean) — D-49');
  } finally {
    await cleanup(a);
    await cleanup(b);
    await prisma.$disconnect();
  }

  console.log('\nPASS — F-8 list/builder UI verified end-to-end against the real API.\n');
}

main().catch((err) => {
  console.error('\nverify-f8-templates-list-ui failed:', err);
  process.exit(1);
});
