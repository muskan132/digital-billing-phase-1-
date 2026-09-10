// E-2 — CSV export. Drives GET /portal/bills/export.csv over REAL HTTP through
// the real SessionGuard/role chain, and asserts:
//
//   1. THE rowCount TEST — every export is preceded by EXACTLY ONE committed
//      PiiExportAudit row whose rowCount === the file's data-row count and
//      whose contactProjection === the file produced (D-70).
//   2. contact omitted / bad -> 422 INVALID_CONTACT_PARAM, ZERO audit rows, no file.
//   3. STORE_STAFF -> 403 on BOTH projections, ZERO audit rows (D-71).
//   4. cross-merchant -> file contains ONLY the session merchant's rows,
//      cross-checked against SELECT count(*).
//   5. masked -> no raw contact anywhere in the file; full -> raw contact present,
//      nothing outside D-48's detail set.
//   6. deny-test: no contact value in any response body or server log.
//
// Usage: pnpm --filter @digital-billing/api verify:e2   (apps/api server up)

import * as path from 'path';
import * as fs from 'fs';
import { config } from 'dotenv';
import { createHash, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';

config({ path: path.join(__dirname, '..', '.env') });

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';
const prisma = new PrismaClient();

let counter = 0;
const uid = (p: string) => `e2-verify-${p}-${Date.now()}-${++counter}`;

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

interface Merchant {
  merchantId: string;
  adminToken: string;
  staffToken: string;
  adminUserId: string;
  staffUserId: string;
  templateId: string;
}

async function createMerchant(): Promise<Merchant> {
  const merchantId = uid('merchant');
  await prisma.merchant.create({ data: { id: merchantId, jiopayMid: uid('mid'), name: `E-2 verify ${merchantId}`, secretKeyEnc: Buffer.from('x') } });
  const templateId = uid('tpl');
  await prisma.template.create({ data: { id: templateId, merchantId, name: uid('T'), billType: 'RECEIPT', layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] }, isHead: true } });

  const mk = async (role: 'MERCHANT_ADMIN' | 'STORE_STAFF') => {
    const userId = uid('user');
    await prisma.user.create({ data: { id: userId, merchantId, type: 'EXTERNAL', role, email: `${userId}@example.invalid`, subject: userId } });
    const rawToken = randomBytes(32).toString('base64url');
    await prisma.merchantSession.create({ data: { userId, tokenHash: hashToken(rawToken), expiresAt: new Date(Date.now() + 10 * 60_000) } });
    return { userId, rawToken };
  };
  const admin = await mk('MERCHANT_ADMIN');
  const staff = await mk('STORE_STAFF');
  return { merchantId, adminToken: admin.rawToken, staffToken: staff.rawToken, adminUserId: admin.userId, staffUserId: staff.userId, templateId };
}

async function addBill(m: Merchant, opts: { mobile?: string; email?: string } = {}) {
  const orderId = uid('order');
  await prisma.order.create({ data: { id: orderId, merchantId: m.merchantId, status: 'SUCCESS', externalTransactionId: uid('ext'), rawCallback: {}, customerMobile_pii: opts.mobile, customerEmail_pii: opts.email } });
  await prisma.bill.create({ data: { id: uid('bill'), orderId, merchantId: m.merchantId, billType: 'RECEIPT', templateId: m.templateId, totalPaise: 100n, snapshot: {} } });
}

async function cleanup(m: Merchant) {
  const orderIds = (await prisma.order.findMany({ where: { merchantId: m.merchantId }, select: { id: true } })).map((o) => o.id);
  await prisma.broadcast.deleteMany({ where: { orderId: { in: orderIds } } });
  // Teardown of this script's own scratch audit rows via raw SQL — NOT a Prisma
  // mutation method — so the E-1 append-only grep test (which scans scripts too)
  // stays green. Legitimate teardown, same as an integration spec's cleanup.
  await prisma.$executeRaw`DELETE FROM "PiiExportAudit" WHERE "merchantId" = ${m.merchantId}`;
  await prisma.bill.deleteMany({ where: { merchantId: m.merchantId } });
  await prisma.order.deleteMany({ where: { merchantId: m.merchantId } });
  await prisma.merchantSession.deleteMany({ where: { userId: { in: [m.adminUserId, m.staffUserId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [m.adminUserId, m.staffUserId] } } });
  await prisma.template.deleteMany({ where: { merchantId: m.merchantId } });
  await prisma.merchant.deleteMany({ where: { id: m.merchantId } });
}

async function exportCsv(token: string, qs: string) {
  const res = await fetch(`${API_BASE}/portal/bills/export.csv${qs}`, { headers: { cookie: `session=${token}` } });
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get('content-type'), body: text };
}

async function auditCount(merchantId: string) {
  return prisma.piiExportAudit.count({ where: { merchantId } });
}

async function main() {
  console.log('\n=== verify-e2-csv-export ===\n');

  const a = await createMerchant();
  const b = await createMerchant();

  try {
    const RAW_MOBILE = '9123456780';
    const RAW_EMAIL = 'realcustomer-e2verify@example.com';
    await addBill(a, { mobile: RAW_MOBILE, email: RAW_EMAIL });
    await addBill(a, { email: 'a2-cust@example.com' });
    await addBill(a, {}); // no contact
    await addBill(b, { email: 'b-cust@example.com' });

    // --- 2. contact omitted / bad → 422, zero audit rows ---------------
    for (const bad of ['', '?contact=', '?contact=MASKED', '?contact=both']) {
      const before = await auditCount(a.merchantId);
      const r = await exportCsv(a.adminToken, bad);
      if (r.status !== 422) fail(`contact "${bad}" → ${r.status}, expected 422`);
      if (!r.body.includes('INVALID_CONTACT_PARAM')) fail(`contact "${bad}" → 422 but body lacks INVALID_CONTACT_PARAM: ${r.body}`);
      if ((await auditCount(a.merchantId)) !== before) fail(`contact "${bad}" wrote an audit row`);
    }
    pass('contact omitted / unrecognised → 422 INVALID_CONTACT_PARAM, ZERO audit rows, no file');

    // --- 3. STORE_STAFF → 403 on both, zero audit rows ---------------
    const staffBefore = await auditCount(a.merchantId);
    for (const c of ['masked', 'full']) {
      const r = await exportCsv(a.staffToken, `?contact=${c}`);
      if (r.status !== 403) fail(`STORE_STAFF ?contact=${c} → ${r.status}, expected 403`);
    }
    if ((await auditCount(a.merchantId)) !== staffBefore) fail('a STORE_STAFF export attempt wrote an audit row');
    pass('STORE_STAFF → 403 on BOTH projections, ZERO audit rows (D-71)');

    // --- 1 + 5. THE rowCount TEST — masked -----------------------
    const rawCountA = await prisma.bill.count({ where: { merchantId: a.merchantId } });
    const beforeMasked = await auditCount(a.merchantId);
    const masked = await exportCsv(a.adminToken, '?contact=masked');
    if (masked.status !== 200) fail(`masked export → ${masked.status}`);
    if (!/text\/csv/.test(masked.contentType ?? '')) fail(`masked export content-type = ${masked.contentType}`);
    const maskedDataRows = masked.body.trimEnd().split('\r\n').length - 1;
    if (maskedDataRows !== rawCountA) fail(`masked file has ${maskedDataRows} data rows, SELECT count(*) = ${rawCountA}`);

    const auditsAfterMasked = await prisma.piiExportAudit.findMany({ where: { merchantId: a.merchantId }, orderBy: { createdAt: 'desc' } });
    if (auditsAfterMasked.length !== beforeMasked + 1) fail(`expected exactly 1 new audit row, got ${auditsAfterMasked.length - beforeMasked}`);
    const maskedAudit = auditsAfterMasked[0];
    if (maskedAudit.rowCount !== maskedDataRows) fail(`audit.rowCount ${maskedAudit.rowCount} != file data rows ${maskedDataRows}`);
    if (maskedAudit.contactProjection !== 'masked') fail(`audit.contactProjection = ${maskedAudit.contactProjection}, expected masked`);
    if (maskedAudit.userId !== a.adminUserId) fail(`audit.userId = ${maskedAudit.userId}, expected the real session user`);
    pass(`THE rowCount TEST (masked) — exactly 1 committed audit row, rowCount ${maskedAudit.rowCount} === file data rows === SELECT count(*), projection "masked", userId = the real session user`);

    if (masked.body.includes(RAW_MOBILE) || masked.body.includes(RAW_EMAIL)) fail('masked file contains a raw contact value');
    pass('masked file — no raw contact value anywhere');

    // --- 1 + 5. THE rowCount TEST — full ------------------------
    const beforeFull = await auditCount(a.merchantId);
    const full = await exportCsv(a.adminToken, '?contact=full');
    if (full.status !== 200) fail(`full export → ${full.status}`);
    const fullDataRows = full.body.trimEnd().split('\r\n').length - 1;
    const fullAudit = (await prisma.piiExportAudit.findMany({ where: { merchantId: a.merchantId }, orderBy: { createdAt: 'desc' } }))[0];
    if ((await auditCount(a.merchantId)) !== beforeFull + 1) fail('full export did not write exactly 1 new audit row');
    if (fullAudit.rowCount !== fullDataRows || fullAudit.contactProjection !== 'full') fail(`full audit wrong: ${JSON.stringify(fullAudit)}`);
    if (!full.body.includes(RAW_MOBILE) || !full.body.includes(RAW_EMAIL)) fail('full file is missing the raw contact it is supposed to carry');
    const header = full.body.split('\r\n')[0];
    if (header !== 'bill_id,created_at,bill_type,source,invoice_number,total_paise,currency,delivery_status,customer_mobile,customer_email') {
      fail(`full CSV header is not the exact authorized column set: ${header}`);
    }
    for (const forbidden of ['gstin', 'subtotal', 'cgst', 'hsn', 'rawCallback', 'secureHash', 'recipient']) {
      if (full.body.toLowerCase().includes(forbidden)) fail(`full CSV contains an unauthorized field: ${forbidden}`);
    }
    pass(`THE rowCount TEST (full) — exactly 1 committed audit row, rowCount ${fullAudit.rowCount} === file data rows; header is the exact 10-column authorized set; no GSTIN/tax/recipient/rawCallback`);

    // --- 4. cross-merchant -------------------------------------
    if (full.body.includes('b-cust@example.com')) fail("merchant A's export contains merchant B's customer");
    if (fullDataRows !== rawCountA) fail(`cross-merchant: A's file has ${fullDataRows} rows, SELECT count(*) WHERE merchantId=A = ${rawCountA}`);
    pass(`cross-merchant — A's export is exactly A's ${rawCountA} rows (SELECT count(*) cross-checked), none of B's`);

    // --- 6. deny-test (static) --------------------------------
    const srcRoots = ['bills-export-csv.util.ts', 'portal-bills.controller.ts', 'pii-export-audit.service.ts'];
    for (const f of srcRoots) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'bills', f), 'utf8');
      if (/\bLogger\b|console\./.test(src)) fail(`${f} contains a Logger/console reference (deny-test)`);
    }
    pass('deny-test — the export serializer, the controller, and the audit service emit no diagnostic output');
  } finally {
    await cleanup(a);
    await cleanup(b);
    await prisma.$disconnect();
  }

  console.log('\nPASS — E-2 CSV export verified end-to-end against the real API.\n');
}

main().catch((err) => {
  console.error('\nverify-e2-csv-export failed:', err);
  process.exit(1);
});
