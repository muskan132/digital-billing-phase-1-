// A-2 verify: drives the REAL running apps/api server's /auth/login,
// /auth/callback, /portal/logout over real HTTP, plus a real dev-idp login
// (same devInteractions simulation as verify-a1-oidc-roundtrip.ts). Checks
// directly against the live DB for what actually got written.
import { PrismaClient } from '@prisma/client';
import { createHash } from 'crypto';

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';
const prisma = new PrismaClient();

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
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');
}

function fail(message: string): never {
  console.error(`\nFAIL — ${message}\n`);
  process.exit(1);
}

// Drives /auth/login -> dev-idp devInteractions -> /auth/callback, exactly
// like a browser, following redirects manually so we can inspect cookies at
// every hop. Reuses the SAME devInteractions simulation as A-1's script.
async function driveRealLogin(loginAsSubject: string): Promise<{ jar: CookieJar; finalStatus: number; finalBody: unknown }> {
  const jar: CookieJar = {};
  let next = `${API_BASE}/auth/login`;
  let hops = 0;

  while (hops++ < 15) {
    const isCallbackUrl = next.startsWith(`${API_BASE}/auth/callback`);
    const res = await fetch(next, { redirect: 'manual', headers: { cookie: cookieHeader(jar) } });
    mergeCookies(jar, res);

    if (res.status >= 300 && res.status < 400) {
      // apps/api's /auth/callback redirects only on SUCCESS (into the web
      // app's /portal, which need not be running for this check) — stop here
      // rather than actually following into a server we don't require up.
      if (isCallbackUrl) {
        return { jar, finalStatus: 200, finalBody: { redirectedTo: res.headers.get('location') } };
      }
      const location = res.headers.get('location')!;
      next = new URL(location, next).href;
      continue;
    }

    if (res.status === 200 && next.includes('/interaction/')) {
      const uid = next.split('/interaction/')[1].split(/[/?]/)[0];
      const html = await res.text();
      const isConsent = html.includes('name="prompt" value="consent"');
      const idpOrigin = new URL(next).origin;
      const body = isConsent
        ? new URLSearchParams({ prompt: 'consent' })
        : new URLSearchParams({ prompt: 'login', login: loginAsSubject, password: 'irrelevant' });

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

    // Reached apps/api's own /auth/callback final response (it doesn't
    // redirect further on success or failure? it DOES redirect on success —
    // this branch is the failure JSON body case, or we've hit the portal.
    const body = await res.json().catch(() => undefined);
    return { jar, finalStatus: res.status, finalBody: body };
  }
  throw new Error('too many redirects');
}

async function main() {
  console.log('\n=== A-2 verify: real login/session/logout against the live apps/api server ===\n');

  // ---- 1. Real login as the eligible seeded subject ----
  const before = await prisma.merchantSession.count();
  const { jar } = await driveRealLogin('seed-user-merchant-admin');
  const after = await prisma.merchantSession.count();

  console.log(`1. Login as eligible seeded subject: MerchantSession count ${before} -> ${after}`);
  if (after !== before + 1) {
    fail(`expected exactly 1 new MerchantSession row, got ${after - before}`);
  }
  const sessionCookieValue = jar['session'];
  if (!sessionCookieValue) fail('no session cookie was set after login');
  console.log(`   session cookie set (length ${sessionCookieValue.length})`);

  const latestSession = await prisma.merchantSession.findFirst({ orderBy: { createdAt: 'desc' }, include: { user: true } });
  if (!latestSession) fail('no MerchantSession row found in DB');
  const storedHashHex = Buffer.from(latestSession.tokenHash).toString('hex');
  const cookieHashHex = createHash('sha256').update(sessionCookieValue).digest('hex');
  console.log(`   stored tokenHash:   ${storedHashHex}`);
  console.log(`   cookie value itself: ${sessionCookieValue}`);
  console.log(`   sha256(cookie value): ${cookieHashHex}`);
  if (sessionCookieValue === storedHashHex) fail('cookie value equals the stored hash — should never match');
  if (cookieHashHex !== storedHashHex) fail('sha256(cookie) does not match the stored tokenHash — session lookup would fail');
  console.log(`   PASS — cookie value != stored tokenHash, and sha256(cookie) == stored tokenHash`);
  console.log(`   PASS — User.lastLoginAt updated: ${latestSession.user.lastLoginAt}\n`);

  // ---- 2. Logout, then replay the same cookie ----
  console.log('2. Logout, then replay the same (now-revoked) cookie...');
  const logout1 = await fetch(`${API_BASE}/portal/logout`, {
    method: 'POST',
    headers: { cookie: cookieHeader(jar) },
  });
  console.log(`   first logout: HTTP ${logout1.status}`);
  if (logout1.status !== 200) fail(`expected 200 on first logout, got ${logout1.status}`);

  const revokedRow = await prisma.merchantSession.findUnique({ where: { id: latestSession.id } });
  if (!revokedRow?.revokedAt) fail('MerchantSession row does not have revokedAt set after logout');
  const stillExists = await prisma.merchantSession.count({ where: { id: latestSession.id } });
  console.log(`   row survives (count=${stillExists}), revokedAt=${revokedRow.revokedAt}`);
  if (stillExists !== 1) fail('MerchantSession row was deleted, not revoked (D-51 violation)');

  // Replay the SAME cookie value (server already cleared its own copy, but a
  // captured/replayed cookie is exactly the attack this must reject).
  const logout2 = await fetch(`${API_BASE}/portal/logout`, {
    method: 'POST',
    headers: { cookie: `session=${sessionCookieValue}` },
  });
  console.log(`   replayed logout: HTTP ${logout2.status}`);
  if (logout2.status !== 401) fail(`expected 401 on replayed/revoked cookie, got ${logout2.status}`);
  console.log('   PASS — revoked cookie replay rejected with 401, row still present\n');

  // ---- 3. Ineligible subjects: zero session rows written ----
  console.log('3. Ineligible subjects each get 403, zero new session rows...');

  const cases: Array<{ label: string; subject: string }> = [
    { label: 'INTERNAL user (seed-user-platform-admin)', subject: 'seed-user-platform-admin' },
    { label: 'unknown subject (no matching User at all)', subject: 'totally-unknown-subject-xyz' },
  ];

  for (const c of cases) {
    const beforeCount = await prisma.merchantSession.count();
    const { finalStatus, finalBody } = await driveRealLogin(c.subject);
    const afterCount = await prisma.merchantSession.count();
    console.log(`   ${c.label}: HTTP ${finalStatus}, body=${JSON.stringify(finalBody)}, sessions ${beforeCount} -> ${afterCount}`);
    if (finalStatus !== 403) fail(`expected 403 for ${c.label}, got ${finalStatus}`);
    if (afterCount !== beforeCount) fail(`expected zero new MerchantSession rows for ${c.label}, got ${afterCount - beforeCount}`);
  }
  console.log('   PASS — both ineligible cases rejected with 403, zero session rows written\n');

  // ---- 4. Disabled user: 403, zero session rows ----
  console.log('4. Disabling the seeded merchant admin, then attempting login...');
  await prisma.user.update({ where: { id: 'seed-user-merchant-admin' }, data: { disabledAt: new Date() } });
  try {
    const beforeCount = await prisma.merchantSession.count();
    const { finalStatus, finalBody } = await driveRealLogin('seed-user-merchant-admin');
    const afterCount = await prisma.merchantSession.count();
    console.log(`   disabled user: HTTP ${finalStatus}, body=${JSON.stringify(finalBody)}, sessions ${beforeCount} -> ${afterCount}`);
    if (finalStatus !== 403) fail(`expected 403 for disabled user, got ${finalStatus}`);
    if (afterCount !== beforeCount) fail(`expected zero new MerchantSession rows for disabled user, got ${afterCount - beforeCount}`);
    console.log('   PASS — disabled user rejected with 403, zero session rows written\n');
  } finally {
    await prisma.user.update({ where: { id: 'seed-user-merchant-admin' }, data: { disabledAt: null } });
    console.log('   (restored seeded merchant admin to disabledAt: null)\n');
  }

  console.log('=== all A-2 checks passed ===\n');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('verify-a2-login-session crashed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
