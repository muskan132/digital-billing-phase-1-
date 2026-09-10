// R-1 — delivery visibility. Drives GET /portal/deliveries over REAL HTTP
// through the real SessionGuard chain, and asserts:
//
//   1. THE COUNTS TEST — the status counts reconcile EXACTLY to a hand-written
//      GROUP BY over the Broadcast JOIN Order (the roadmap's literal verify
//      SQL), not the Prisma query builder checking itself.
//   2. THE THREE-LAYER DENY-TEST — (a) the service source has no diagnostic
//      output at all; (b) the HTTP response body contains no raw recipient;
//      (c) the masked value is what the D-48 mask produces.
//   3. cross-merchant isolation, cross-checked against a direct SELECT.
//   4. the FAILED item carries EXACTLY six keys (D-48's five + billId).
//   5. read-tier: STORE_STAFF gets 200.
//   6. a D-7-exhausted row (attempts >= maxAttempts) is visible.
//
// Usage: pnpm --filter @digital-billing/api verify:r1   (apps/api server must be running)

import * as path from 'path';
import * as fs from 'fs';
import { config } from 'dotenv';
import { createHash, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { maskEmailPortal, maskMobilePortal } from '../src/common/portal-contact-mask.util';

config({ path: path.join(__dirname, '..', '.env') });

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';
const prisma = new PrismaClient();

let counter = 0;
const uid = (p: string) => `r1-verify-${p}-${Date.now()}-${++counter}`;

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

async function createSession(role: 'MERCHANT_ADMIN' | 'STORE_STAFF'): Promise<Session> {
  const merchantId = uid('merchant');
  await prisma.merchant.create({ data: { id: merchantId, jiopayMid: uid('mid'), name: `R-1 verify ${merchantId}`, secretKeyEnc: Buffer.from('unused') } });
  const userId = uid('user');
  await prisma.user.create({ data: { id: userId, merchantId, type: 'EXTERNAL', role, email: `${userId}@example.invalid`, subject: userId } });
  const rawToken = randomBytes(32).toString('base64url');
  await prisma.merchantSession.create({ data: { userId, tokenHash: hashToken(rawToken), expiresAt: new Date(Date.now() + 10 * 60_000) } });
  return { merchantId, userId, rawToken };
}

async function cleanup(s: Session): Promise<void> {
  const orderIds = (await prisma.order.findMany({ where: { merchantId: s.merchantId }, select: { id: true } })).map((o) => o.id);
  await prisma.broadcast.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.bill.deleteMany({ where: { merchantId: s.merchantId } });
  await prisma.order.deleteMany({ where: { merchantId: s.merchantId } });
  await prisma.merchantSession.deleteMany({ where: { userId: s.userId } });
  await prisma.user.deleteMany({ where: { id: s.userId } });
  await prisma.template.deleteMany({ where: { merchantId: s.merchantId } });
  await prisma.merchant.deleteMany({ where: { id: s.merchantId } });
}

async function seedOrder(merchantId: string, withBill = false): Promise<string> {
  const orderId = uid('order');
  await prisma.order.create({ data: { id: orderId, merchantId, status: 'SUCCESS', externalTransactionId: uid('ext'), rawCallback: {} } });
  if (withBill) {
    const templateId = uid('tpl');
    await prisma.template.create({ data: { id: templateId, merchantId, name: uid('T'), billType: 'RECEIPT', layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] }, isHead: true } });
    await prisma.bill.create({ data: { id: uid('bill'), orderId, merchantId, billType: 'RECEIPT', templateId, totalPaise: 100n, snapshot: {} } });
  }
  return orderId;
}

async function addBroadcast(orderId: string, opts: { status: 'PENDING' | 'SENT' | 'FAILED'; channel?: 'EMAIL' | 'SMS'; recipient?: string; attempts?: number }) {
  await prisma.broadcast.create({
    data: { orderId, channel: opts.channel ?? 'EMAIL', recipient: opts.recipient ?? 'x@example.com', status: opts.status, attempts: opts.attempts ?? 0, ...(opts.status === 'SENT' ? { sentAt: new Date() } : {}) },
  });
}

async function rawCounts(merchantId: string): Promise<Record<string, number>> {
  const rows = await prisma.$queryRaw<{ status: string; n: bigint }[]>`
    SELECT b."status" AS status, count(*) AS n
    FROM "Broadcast" b JOIN "Order" o ON b."orderId" = o."id"
    WHERE o."merchantId" = ${merchantId}
    GROUP BY b."status"
  `;
  const out: Record<string, number> = { PENDING: 0, SENT: 0, FAILED: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

async function get(s: Session, path: string) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { cookie: `session=${s.rawToken}` } });
  return { status: res.status, json: (await res.json().catch(() => null)) as any };
}

async function main() {
  console.log('\n=== verify-r1-delivery-visibility ===\n');

  // --- deny-test layer (a): the service source itself ---------------------
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'bills', 'portal-deliveries.service.ts'), 'utf8');
  if (/\bLogger\b|console\./.test(src)) fail('portal-deliveries.service.ts contains a Logger/console reference');
  pass('deny-test (a): portal-deliveries.service.ts has no Logger and no console call');

  const admin = await createSession('MERCHANT_ADMIN');
  const staff = await createSession('STORE_STAFF');
  const other = await createSession('MERCHANT_ADMIN');

  const RAW_EMAIL = 'realcustomer-r1verify@example.com';
  const RAW_MOBILE = '9998887771';

  try {
    // --- seed a realistic spread for `admin` ---------------------------
    const o1 = await seedOrder(admin.merchantId);
    const o2 = await seedOrder(admin.merchantId, true);
    const o3 = await seedOrder(admin.merchantId, true);
    await addBroadcast(o1, { status: 'SENT' });
    await addBroadcast(o1, { status: 'SENT' });
    await addBroadcast(o1, { status: 'SENT' });
    await addBroadcast(o1, { status: 'PENDING' });
    await addBroadcast(o2, { status: 'FAILED', attempts: 2, channel: 'EMAIL', recipient: RAW_EMAIL });
    await addBroadcast(o3, { status: 'FAILED', attempts: 5, channel: 'SMS', recipient: RAW_MOBILE }); // D-7 exhausted

    // --- seed `other` (cross-merchant) --------------------------------
    const ob = await seedOrder(other.merchantId, true);
    await addBroadcast(ob, { status: 'FAILED', attempts: 4, recipient: 'other-merchant-cust@example.com' });
    await addBroadcast(ob, { status: 'SENT' });

    // --- 1. THE COUNTS TEST ------------------------------------------
    const res = await get(admin, '/portal/deliveries');
    if (res.status !== 200) fail(`GET /portal/deliveries → ${res.status}`);
    const raw = await rawCounts(admin.merchantId);
    if (JSON.stringify(res.json.counts) !== JSON.stringify(raw)) {
      fail(`counts do not reconcile to the raw GROUP BY:\n  service: ${JSON.stringify(res.json.counts)}\n  raw SQL: ${JSON.stringify(raw)}`);
    }
    if (JSON.stringify(res.json.counts) !== JSON.stringify({ PENDING: 1, SENT: 3, FAILED: 2 })) {
      fail(`counts wrong: ${JSON.stringify(res.json.counts)}`);
    }
    pass(`THE COUNTS TEST — service counts ${JSON.stringify(res.json.counts)} === raw "SELECT status, count(*) ... WHERE merchantId" GROUP BY`);

    // --- 2. THE THREE-LAYER DENY-TEST (b + c) -----------------------
    const bodyStr = JSON.stringify(res.json);
    if (bodyStr.includes(RAW_EMAIL)) fail('the raw email recipient appears in the HTTP response body');
    if (bodyStr.includes(RAW_MOBILE)) fail('the raw mobile recipient appears in the HTTP response body');
    pass('deny-test (b): no raw recipient (email or mobile) anywhere in the HTTP response body');

    const failedEmail = res.json.failed.find((f: any) => f.channel === 'EMAIL');
    const failedSms = res.json.failed.find((f: any) => f.channel === 'SMS');
    if (failedEmail.recipientMasked !== maskEmailPortal(RAW_EMAIL)) fail(`EMAIL recipient not masked by the D-48 email mask: ${failedEmail.recipientMasked}`);
    if (failedSms.recipientMasked !== maskMobilePortal(RAW_MOBILE)) fail(`SMS recipient not masked by the D-48 mobile mask: ${failedSms.recipientMasked}`);
    pass(`deny-test (c): recipientMasked is exactly the D-48 mask output ("${failedEmail.recipientMasked}", "${failedSms.recipientMasked}")`);

    // --- 4. six-key whitelist -------------------------------------
    const keys = Object.keys(failedEmail).sort();
    if (keys.join(',') !== 'attempts,billId,channel,recipientMasked,sentAt,status') {
      fail(`FAILED item keys are not exactly the six-field whitelist: ${keys.join(', ')}`);
    }
    for (const banned of ['recipient', 'error', 'id', 'orderId', 'order', 'createdAt']) {
      if (banned in failedEmail) fail(`FAILED item leaked "${banned}"`);
    }
    pass('FAILED item carries EXACTLY {attempts, billId, channel, recipientMasked, sentAt, status} — no recipient/error/id/orderId');

    // --- 6. D-7 exhausted row visible ---------------------------
    if (failedSms.attempts !== 5 || res.json.maxAttempts !== 5 || failedSms.attempts < res.json.maxAttempts) {
      fail(`D-7-exhausted row not represented correctly: attempts=${failedSms.attempts}, maxAttempts=${res.json.maxAttempts}`);
    }
    pass(`D-7-exhausted FAILED row visible — attempts ${failedSms.attempts} >= top-level maxAttempts ${res.json.maxAttempts} ("no longer retrying")`);

    // --- 3. cross-merchant isolation ---------------------------
    const otherFailedRaw = await prisma.broadcast.count({ where: { status: 'FAILED', order: { merchantId: other.merchantId } } });
    if (otherFailedRaw === 0) fail('setup error — the other merchant has no FAILED rows');
    if (res.json.failed.length !== 2) fail(`admin sees ${res.json.failed.length} failed rows, expected exactly its own 2`);
    if (bodyStr.includes('other-merchant-cust@example.com')) fail("another merchant's recipient appears in admin's response");
    const otherRes = await get(other, '/portal/deliveries');
    if (JSON.stringify(otherRes.json.counts) !== JSON.stringify(await rawCounts(other.merchantId))) fail("the other merchant's own counts do not reconcile");
    pass(`cross-merchant isolation — admin's list is its own 2 rows; the other merchant has ${otherFailedRaw} FAILED rows, absent from admin's counts AND list (direct SELECT cross-checked)`);

    // --- 5. read-tier ------------------------------------------
    const staffRes = await get(staff, '/portal/deliveries');
    if (staffRes.status !== 200) fail(`STORE_STAFF → ${staffRes.status}, expected 200 (read-tier)`);
    pass('read-tier: STORE_STAFF gets 200 (delivery visibility is a read)');
  } finally {
    await cleanup(admin);
    await cleanup(staff);
    await cleanup(other);
    await prisma.$disconnect();
  }

  console.log('\nPASS — R-1 delivery visibility verified end-to-end against the real API.\n');
}

main().catch((err) => {
  console.error('\nverify-r1-delivery-visibility failed:', err);
  process.exit(1);
});
