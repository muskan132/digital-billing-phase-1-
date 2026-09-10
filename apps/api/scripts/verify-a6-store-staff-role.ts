// A-6 (D-50): the first REAL STORE_STAFF principal. Drives a real OIDC login as
// `seed-user-store-staff` through the running dev-idp + apps/api, then:
//
//   1. distinct session issuance for the second principal; MerchantContext.role
//      === STORE_STAFF (via GET /portal/me).
//   2. read-tier routes -> 200.
//   3. THE CSRF-vs-ROLE DISTINCTION — every MERCHANT_ADMIN-only write route,
//      hit WITH a valid CSRF token, returns 403 whose body is a plain Forbidden
//      (no error_code), NOT { error_code: 'CSRF_TOKEN_INVALID' }. That is what
//      proves the ROLE gate fired, not CSRF enforcement.
//   4. D-45 — disabling the STORE_STAFF user mid-session kills the NEXT request
//      (401), the existing session cookie no longer works.
//   5. the MERCHANT_ADMIN still logs in and gets its own distinct session.
//
// Usage: pnpm --filter @digital-billing/api verify:a6  (apps/api + dev-idp up)

import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';
const prisma = new PrismaClient();

const STORE_STAFF_SUBJECT = 'seed-user-store-staff';
const MERCHANT_ADMIN_SUBJECT = 'seed-user-merchant-admin';

function fail(message: string): never {
  console.error(`\nFAIL — ${message}\n`);
  process.exit(1);
}
function pass(message: string): void {
  console.log(`PASS  ${message}`);
}

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

// Same devInteractions simulation verify-a1/a2/w1 use: /auth/login -> dev-idp
// login prompt -> consent -> /auth/callback, redirects followed by hand.
async function driveRealLogin(subject: string): Promise<{ jar: CookieJar; finalStatus: number; finalBody: unknown }> {
  const jar: CookieJar = {};
  let next = `${API_BASE}/auth/login`;
  let hops = 0;

  while (hops++ < 15) {
    const isCallbackUrl = next.startsWith(`${API_BASE}/auth/callback`);
    const res = await fetch(next, { redirect: 'manual', headers: { cookie: cookieHeader(jar) } });
    mergeCookies(jar, res);

    if (res.status >= 300 && res.status < 400) {
      if (isCallbackUrl) {
        return { jar, finalStatus: 200, finalBody: { redirectedTo: res.headers.get('location') } };
      }
      next = new URL(res.headers.get('location')!, next).href;
      continue;
    }

    if (res.status === 200 && next.includes('/interaction/')) {
      const uid = next.split('/interaction/')[1].split(/[/?]/)[0];
      const html = await res.text();
      const isConsent = html.includes('name="prompt" value="consent"');
      const idpOrigin = new URL(next).origin;
      const body = isConsent
        ? new URLSearchParams({ prompt: 'consent' })
        : new URLSearchParams({ prompt: 'login', login: subject, password: 'irrelevant' });

      const submitRes = await fetch(`${idpOrigin}/interaction/${uid}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
        body: body.toString(),
      });
      mergeCookies(jar, submitRes);
      next = new URL(submitRes.headers.get('location')!, idpOrigin).href;
      continue;
    }

    const finalBody = await res.json().catch(() => undefined);
    return { jar, finalStatus: res.status, finalBody };
  }
  throw new Error('too many redirects');
}

async function get(jar: CookieJar, path: string) {
  const res = await fetch(`${API_BASE}${path}`, { headers: { cookie: cookieHeader(jar) } });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function write(jar: CookieJar, method: 'POST' | 'DELETE', path: string, csrf: string) {
  const res = await fetch(`${API_BASE}${path}`, { method, headers: { cookie: cookieHeader(jar), 'x-csrf-token': csrf } });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

async function main() {
  console.log('\n=== verify-a6-store-staff-role ===\n');

  // --- 1. real login as the STORE_STAFF subject ------------------------
  const before = await prisma.merchantSession.count();
  const { jar, finalStatus } = await driveRealLogin(STORE_STAFF_SUBJECT);
  if (finalStatus !== 200) fail(`STORE_STAFF login did not complete (final status ${finalStatus})`);
  const after = await prisma.merchantSession.count();
  if (after !== before + 1) fail(`expected exactly 1 new MerchantSession, got ${after - before}`);

  const cookie = jar['session'];
  if (!cookie) fail('no session cookie set after STORE_STAFF login');

  const staffSession = await prisma.merchantSession.findFirst({ orderBy: { createdAt: 'desc' }, include: { user: true } });
  if (!staffSession) fail('no MerchantSession row found');
  if (staffSession.user.id !== STORE_STAFF_SUBJECT) fail(`session belongs to ${staffSession.user.id}, expected ${STORE_STAFF_SUBJECT}`);
  if (staffSession.user.role !== 'STORE_STAFF') fail(`session user role is ${staffSession.user.role}, expected STORE_STAFF`);
  if (createHash('sha256').update(cookie).digest('hex') !== Buffer.from(staffSession.tokenHash).toString('hex')) {
    fail('sha256(cookie) does not match the stored tokenHash');
  }
  pass(`real OIDC login as ${STORE_STAFF_SUBJECT} → 1 distinct MerchantSession, sha256(cookie)==tokenHash, user.role=STORE_STAFF`);

  // --- 2. MerchantContext.role on the hot path ------------------------
  const me = await get(jar, '/portal/me');
  if (me.status !== 200 || me.json?.role !== 'STORE_STAFF') fail(`GET /portal/me → ${me.status} ${JSON.stringify(me.json)}`);
  pass(`GET /portal/me → 200, role="STORE_STAFF", merchantName=${JSON.stringify(me.json?.merchantName)}`);

  // --- 3. read-tier routes → 200 -----------------------------------
  const reads = ['/portal/bills', '/portal/bills?limit=5', '/portal/deliveries', '/portal/templates', '/portal/templates/archived', '/portal/templates/defaults', '/portal/templates/seed-template-receipt'];
  for (const p of reads) {
    const r = await get(jar, p);
    if (r.status !== 200) fail(`STORE_STAFF GET ${p} → ${r.status}, expected 200 (read-tier)`);
  }
  pass(`read-tier routes all 200 for STORE_STAFF: ${reads.join(', ')}`);

  // --- 4. THE CSRF-vs-ROLE DISTINCTION ----------------------------
  const csrfRes = await fetch(`${API_BASE}/portal/csrf-token`, { headers: { cookie: cookieHeader(jar) } });
  if (!csrfRes.ok) fail(`STORE_STAFF GET /portal/csrf-token → ${csrfRes.status} (should be role-unrestricted)`);
  const csrf = ((await csrfRes.json()) as { token: string }).token;
  pass('STORE_STAFF obtained a real CSRF token (GET /portal/csrf-token is role-unrestricted)');

  const someBill = await prisma.bill.findFirst({ select: { id: true } });
  const billId = someBill?.id ?? 'no-bill';

  const writes: Array<{ method: 'POST' | 'DELETE'; path: string }> = [
    { method: 'POST', path: '/portal/templates' },
    { method: 'POST', path: '/portal/templates/seed-template-receipt/save' },
    { method: 'POST', path: '/portal/templates/seed-template-receipt/save-as' },
    { method: 'POST', path: '/portal/templates/seed-template-receipt/set-default' },
    { method: 'POST', path: '/portal/templates/seed-template-receipt/archive' },
    { method: 'POST', path: '/portal/templates/seed-template-receipt/restore' },
    { method: 'DELETE', path: '/portal/templates/seed-template-receipt' },
    { method: 'POST', path: `/portal/bills/${billId}/resend` },
  ];

  console.log('\n  write sweep — every MERCHANT_ADMIN-only route, WITH a valid CSRF token:');
  for (const w of writes) {
    const r = await write(jar, w.method, w.path, csrf);
    const bodyStr = JSON.stringify(r.json);
    console.log(`    ${w.method.padEnd(6)} ${w.path.padEnd(48)} → ${r.status}  body=${bodyStr}`);
    if (r.status !== 403) fail(`${w.method} ${w.path} → ${r.status}, expected 403 (role gate)`);
    if (r.json?.error_code === 'CSRF_TOKEN_INVALID') {
      fail(`${w.method} ${w.path} → 403 but body is CSRF_TOKEN_INVALID — the CSRF guard fired, NOT the role gate. The token was invalid or missing.`);
    }
    if (r.json && 'error_code' in r.json) {
      fail(`${w.method} ${w.path} → 403 with an unexpected error_code ${JSON.stringify(r.json.error_code)} — expected a plain Forbidden`);
    }
  }
  pass('EVERY write route → 403 with a plain Forbidden body (no error_code, NOT CSRF_TOKEN_INVALID) — the ROLE gate fired, not CSRF');

  // --- 5. D-45: disable mid-session → next request 401 ------------
  const disableBefore = await get(jar, '/portal/me');
  if (disableBefore.status !== 200) fail('sanity: STORE_STAFF session should work before the disable');
  await prisma.user.update({ where: { id: STORE_STAFF_SUBJECT }, data: { disabledAt: new Date() } });
  try {
    const afterDisable = await get(jar, '/portal/me');
    console.log(`\n  D-45 mid-session disable — next request with the SAME cookie: HTTP ${afterDisable.status} body=${JSON.stringify(afterDisable.json)}`);
    if (afterDisable.status !== 401) fail(`disabled STORE_STAFF's next request → ${afterDisable.status}, expected 401 (D-45 per-request re-check)`);
    pass('D-45 — disabling the STORE_STAFF user mid-session kills the NEXT request (401), the live session cookie stops working');
  } finally {
    await prisma.user.update({ where: { id: STORE_STAFF_SUBJECT }, data: { disabledAt: null } });
    console.log('  (restored seed-user-store-staff to disabledAt: null)');
  }

  // --- 6. MERCHANT_ADMIN still logs in, distinct session ---------
  const adminBefore = await prisma.merchantSession.count();
  const admin = await driveRealLogin(MERCHANT_ADMIN_SUBJECT);
  if (admin.finalStatus !== 200) fail(`MERCHANT_ADMIN login did not complete (${admin.finalStatus})`);
  if ((await prisma.merchantSession.count()) !== adminBefore + 1) fail('MERCHANT_ADMIN login did not create exactly one session');
  const adminSession = await prisma.merchantSession.findFirst({ orderBy: { createdAt: 'desc' }, include: { user: true } });
  if (adminSession?.user.role !== 'MERCHANT_ADMIN') fail(`admin session role is ${adminSession?.user.role}`);
  if (adminSession?.id === staffSession.id) fail('the two principals share a session row');
  const adminMe = await get(admin.jar, '/portal/me');
  if (adminMe.json?.role !== 'MERCHANT_ADMIN') fail(`admin GET /portal/me role is ${JSON.stringify(adminMe.json?.role)}`);
  pass('MERCHANT_ADMIN logs in independently → its own distinct session, role=MERCHANT_ADMIN — both principals coexist');

  console.log('\nPASS — A-6: the STORE_STAFF role gate is closed by a real principal.\n');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('\nverify-a6-store-staff-role crashed:', err);
  await prisma.user.update({ where: { id: STORE_STAFF_SUBJECT }, data: { disabledAt: null } }).catch(() => {});
  await prisma.$disconnect();
  process.exit(1);
});
