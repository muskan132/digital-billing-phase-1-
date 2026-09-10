// R-2 — resend. Drives POST /portal/bills/:id/resend over REAL HTTP (real
// SessionGuard + CsrfGuard), then runs the REAL drainer, and asserts:
//
//   1. THE ONE-NEW-ROW + OLD-ROW-BYTE-IDENTICAL test — resend creates exactly
//      one new Broadcast (PENDING, attempts 0, stored recipient) and the
//      original FAILED row is byte-identical afterwards.
//   2. THE REAL DELIVERY — the drainer picks the new row up and Mailhog shows
//      the email (skipped with a clear notice if Mailhog is unreachable,
//      matching verify:x3's API-server precedent).
//   3. a `recipient` in the request body has NO effect (proven, not assumed).
//   4. a second resend while the first is PENDING -> 422, zero writes.
//   5. resend on a SENT-only bill -> 422.
//   6. STORE_STAFF -> 403; another merchant's billId -> 404.
//
// Usage: pnpm --filter @digital-billing/api verify:r2   (apps/api server + docker compose)

import * as path from 'path';
import { config } from 'dotenv';
import { createHash, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { BroadcastDrainerService } from '../src/broadcast/broadcast-drainer.service';
import { BroadcastSenderService } from '../src/broadcast/broadcast-sender.service';

config({ path: path.join(__dirname, '..', '.env') });

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';
const MAILHOG_API = 'http://localhost:8025/api/v2';
const prisma = new PrismaClient();

let counter = 0;
const uid = (p: string) => `r2-verify-${p}-${Date.now()}-${++counter}`;

function fail(msg: string): never {
  throw new Error(`FAIL — ${msg}`);
}
function pass(msg: string): void {
  console.log(`PASS  ${msg}`);
}
function skip(msg: string): void {
  console.log(`SKIP  ${msg}`);
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
  await prisma.merchant.create({ data: { id: merchantId, jiopayMid: uid('mid'), name: `R-2 verify ${merchantId}`, secretKeyEnc: Buffer.from('unused') } });
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
  await prisma.bill.deleteMany({ where: { merchantId: s.merchantId } });
  await prisma.order.deleteMany({ where: { merchantId: s.merchantId } });
  await prisma.merchantSession.deleteMany({ where: { userId: s.userId } });
  await prisma.user.deleteMany({ where: { id: s.userId } });
  await prisma.template.deleteMany({ where: { merchantId: s.merchantId } });
  await prisma.merchant.deleteMany({ where: { id: s.merchantId } });
}

const cookie = (s: Session) => `session=${s.rawToken}`;

async function csrf(s: Session): Promise<string> {
  const res = await fetch(`${API_BASE}/portal/csrf-token`, { headers: { cookie: cookie(s) } });
  if (!res.ok) fail(`csrf-token → ${res.status}`);
  return ((await res.json()) as { token: string }).token;
}

async function resendHttp(s: Session, billId: string, body?: unknown) {
  const res = await fetch(`${API_BASE}/portal/bills/${billId}/resend`, {
    method: 'POST',
    headers: { cookie: cookie(s), 'x-csrf-token': await csrf(s), ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function seedBillWithFailed(s: Session, recipient: string, opts: { attempts?: number } = {}) {
  const orderId = uid('order');
  await prisma.order.create({ data: { id: orderId, merchantId: s.merchantId, status: 'SUCCESS', externalTransactionId: uid('ext'), rawCallback: {} } });
  await prisma.link.create({ data: { orderId, identifier: randomBytes(8).toString('hex') } });
  const templateId = uid('tpl');
  await prisma.template.create({ data: { id: templateId, merchantId: s.merchantId, name: uid('T'), billType: 'RECEIPT', layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] }, isHead: true } });
  const billId = uid('bill');
  await prisma.bill.create({ data: { id: billId, orderId, merchantId: s.merchantId, billType: 'RECEIPT', templateId, totalPaise: 100n, snapshot: {} } });
  const failed = await prisma.broadcast.create({ data: { orderId, channel: 'EMAIL', recipient, status: 'FAILED', attempts: opts.attempts ?? 5, error: 'timeout: SMTP send failed' } });
  return { orderId, billId, failed };
}

async function mailhogReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${MAILHOG_API}/messages?limit=1`);
    return res.ok;
  } catch {
    return false;
  }
}

async function mailhogHasMessageTo(recipient: string): Promise<boolean> {
  const res = await fetch(`${MAILHOG_API}/search?kind=to&query=${encodeURIComponent(recipient)}`);
  if (!res.ok) return false;
  const body = (await res.json()) as { total: number };
  return body.total > 0;
}

async function main() {
  console.log('\n=== verify-r2-resend ===\n');

  const admin = await createSession('MERCHANT_ADMIN');
  const staff = await createSession('STORE_STAFF');
  const other = await createSession('MERCHANT_ADMIN');
  const drainer = new BroadcastDrainerService(new PrismaService(), new BroadcastSenderService());

  try {
    // --- 1. THE ONE-NEW-ROW + OLD-ROW-BYTE-IDENTICAL TEST -----------------
    const RAW = `r2-cust-${Date.now()}@example.com`;
    const { orderId, billId, failed } = await seedBillWithFailed(admin, RAW);
    const before = await prisma.broadcast.findUniqueOrThrow({ where: { id: failed.id } });
    const countBefore = await prisma.broadcast.count({ where: { orderId } });

    const r = await resendHttp(admin, billId);
    if (r.status !== 201) fail(`resend → ${r.status}: ${JSON.stringify(r.json)}`);
    if (JSON.stringify(r.json) !== JSON.stringify({ resent: true, channel: 'EMAIL' })) fail(`resend body wrong: ${JSON.stringify(r.json)}`);
    if (JSON.stringify(r.json).includes(RAW)) fail('resend response body leaked the raw recipient');

    if ((await prisma.broadcast.count({ where: { orderId } })) !== countBefore + 1) fail('resend did not create exactly one new row');
    const after = await prisma.broadcast.findUniqueOrThrow({ where: { id: failed.id } });
    if (JSON.stringify(after) !== JSON.stringify(before)) fail(`the original FAILED row changed:\n  before ${JSON.stringify(before)}\n  after  ${JSON.stringify(after)}`);
    pass('THE ONE-NEW-ROW test — resend created exactly 1 new row; the original FAILED row is byte-identical (attempts, error, updatedAt all unchanged)');

    const fresh = await prisma.broadcast.findFirstOrThrow({ where: { orderId, id: { not: failed.id } } });
    if (fresh.status !== 'PENDING' || fresh.attempts !== 0 || fresh.channel !== 'EMAIL' || fresh.recipient !== RAW || fresh.sentAt !== null || fresh.error !== null) {
      fail(`new row wrong: ${JSON.stringify(fresh)}`);
    }
    pass('the new row is PENDING / attempts 0 / channel + STORED recipient copied / sentAt + error null — matches the drainer candidate query');

    // --- 2. THE REAL DELIVERY ------------------------------------------
    const mailhog = await mailhogReachable();
    await drainer.drain();
    const drained = await prisma.broadcast.findUniqueOrThrow({ where: { id: fresh.id } });
    if (mailhog) {
      if (drained.status !== 'SENT') fail(`after a real drain the new row is ${drained.status}, expected SENT (Mailhog is reachable)`);
      if (!(await mailhogHasMessageTo(RAW))) fail('the new row is SENT but Mailhog has no message to that recipient');
      pass(`THE REAL DELIVERY — the drainer picked the new row up, it is SENT, and Mailhog shows the email to ${RAW.replace(/^(..).*(@.*)$/, '$1***$2')}`);
    } else if (drained.attempts === 1) {
      skip('Mailhog not reachable — cannot confirm the email delivery. The drainer DID pick the new row up (attempts 0 → 1), proving it matched the candidate query.');
    } else {
      fail(`Mailhog unreachable AND the drainer did not touch the new row (status ${drained.status}, attempts ${drained.attempts})`);
    }

    // --- 3. request body carrying a recipient has NO effect -----------
    const RAW2 = `r2-cust2-${Date.now()}@example.com`;
    const seed2 = await seedBillWithFailed(admin, RAW2);
    const r3 = await resendHttp(admin, seed2.billId, { recipient: 'attacker@evil.com' });
    if (r3.status !== 201) fail(`resend with body → ${r3.status}`);
    const new2 = await prisma.broadcast.findFirstOrThrow({ where: { orderId: seed2.orderId, status: 'PENDING' } });
    if (new2.recipient !== RAW2) fail(`the request-body recipient took effect: new row recipient is ${new2.recipient}`);
    const anyAttacker = await prisma.broadcast.count({ where: { recipient: 'attacker@evil.com' } });
    if (anyAttacker !== 0) fail('a broadcast row with the attacker-supplied recipient was created');
    pass('a request body { recipient: "attacker@evil.com" } has NO effect — new row uses the STORED recipient, attacker address nowhere in the DB');

    // --- 4. second resend while PENDING → 422, zero writes -----------
    const countB4 = await prisma.broadcast.count({ where: { orderId: seed2.orderId } });
    const r4 = await resendHttp(admin, seed2.billId);
    if (r4.status !== 422 || r4.json?.error_code !== 'RESEND_ALREADY_PENDING') fail(`2nd resend while PENDING → ${r4.status} ${JSON.stringify(r4.json)}`);
    if ((await prisma.broadcast.count({ where: { orderId: seed2.orderId } })) !== countB4) fail('the refused 2nd resend still wrote a row');
    pass('a 2nd resend while the first is PENDING → 422 RESEND_ALREADY_PENDING, zero writes');

    // --- 5. resend on a SENT-only bill → 422 ------------------------
    const sentOrder = uid('order');
    await prisma.order.create({ data: { id: sentOrder, merchantId: admin.merchantId, status: 'SUCCESS', externalTransactionId: uid('ext'), rawCallback: {} } });
    const sentTpl = uid('tpl');
    await prisma.template.create({ data: { id: sentTpl, merchantId: admin.merchantId, name: uid('T'), billType: 'RECEIPT', layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] }, isHead: true } });
    const sentBill = uid('bill');
    await prisma.bill.create({ data: { id: sentBill, orderId: sentOrder, merchantId: admin.merchantId, billType: 'RECEIPT', templateId: sentTpl, totalPaise: 100n, snapshot: {} } });
    await prisma.broadcast.create({ data: { orderId: sentOrder, channel: 'EMAIL', recipient: 'delivered@example.com', status: 'SENT', sentAt: new Date() } });
    const r5 = await resendHttp(admin, sentBill);
    if (r5.status !== 422 || r5.json?.error_code !== 'NO_FAILED_BROADCAST') fail(`resend on SENT-only bill → ${r5.status} ${JSON.stringify(r5.json)}`);
    pass('resend on a bill whose only delivery is SENT → 422 NO_FAILED_BROADCAST');

    // --- 6. STORE_STAFF → 403; cross-merchant → 404 ---------------
    const seed6 = await seedBillWithFailed(admin, `r2-cust6-${Date.now()}@example.com`);
    const rStaff = await resendHttp(staff, seed6.billId);
    if (rStaff.status !== 403) fail(`STORE_STAFF resend → ${rStaff.status}, expected 403`);
    pass('STORE_STAFF → 403 (resend is MERCHANT_ADMIN only)');

    const cnt = await prisma.broadcast.count({ where: { orderId: seed6.orderId } });
    const rCross = await resendHttp(other, seed6.billId);
    if (rCross.status !== 404) fail(`cross-merchant billId → ${rCross.status}, expected 404`);
    if ((await prisma.broadcast.count({ where: { orderId: seed6.orderId } })) !== cnt) fail('cross-merchant resend still wrote a row');
    pass("another merchant's billId → 404, zero writes");
  } finally {
    await cleanup(admin);
    await cleanup(staff);
    await cleanup(other);
    await prisma.$disconnect();
  }

  console.log('\nPASS — R-2 resend verified end-to-end against the real API.\n');
}

main().catch((err) => {
  console.error('\nverify-r2-resend failed:', err);
  process.exit(1);
});
