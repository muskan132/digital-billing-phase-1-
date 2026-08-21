// A-1 verify: drives the REAL OidcIdentityProviderAdapter against the REAL
// dev-idp process (assumed already running on DEV_IDP_ISSUER) through a full
// browser-less authorization code + PKCE round trip, then runs the three
// deliberate-failure cases (tampered id_token signature, replayed state,
// mismatched nonce).
//
// This file simulates ONLY the browser's form submission to dev-idp's
// devInteractions login/consent screens (plain fetch + manual cookie/redirect
// handling) — it never imports `oidc-provider` itself (D-53's isolation is
// about apps/api never depending on that package, and this script is part of
// apps/api). Everything after the simulated browser step — discovery, the
// authorization URL, the token exchange, id_token verification — runs through
// the real adapter apps/api will actually use.
import * as client from 'openid-client';
import { OidcIdentityProviderAdapter } from '../src/auth/oidc-identity-provider.adapter';

const ISSUER = process.env.DEV_IDP_ISSUER ?? 'http://localhost:9000';
const REDIRECT_URI = process.env.DEV_IDP_REDIRECT_URI ?? 'http://localhost:4000/auth/callback';
const CLIENT_ID = 'digital-billing-portal';
const SEEDED_SUBJECT = 'seed-user-merchant-admin';

interface CookieJar {
  [name: string]: string;
}

function mergeCookies(jar: CookieJar, res: Response) {
  // Node's fetch exposes multiple Set-Cookie headers via getSetCookie().
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

// Drives dev-idp's devInteractions login + consent screens exactly like a
// browser would (GET the interaction page, POST the form), following manual
// redirects so we can capture the final `?code=...&state=...` callback URL
// without needing a real server listening at REDIRECT_URI.
async function driveBrowserThroughLogin(authorizationUrl: string): Promise<URL> {
  const jar: CookieJar = {};
  let next = authorizationUrl;

  for (let hop = 0; hop < 10; hop++) {
    const res = await fetch(next, { redirect: 'manual', headers: { cookie: cookieHeader(jar) } });
    mergeCookies(jar, res);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new Error(`redirect with no Location header at ${next}`);
      const resolved = new URL(location, next);

      if (resolved.href.startsWith(REDIRECT_URI)) {
        return resolved; // reached the client's own callback — done
      }
      next = resolved.href;
      continue;
    }

    if (res.status === 200 && next.includes('/interaction/')) {
      const uid = next.split('/interaction/')[1].split(/[/?]/)[0];
      const html = await res.text();
      const isConsent = html.includes('name="prompt" value="consent"');
      // devInteractions uses whatever `login` value is submitted AS the
      // accountId verbatim (lib/actions/interaction.js) — it never checks
      // `password` at all (D-54). We submit the one subject dev-idp's own
      // findAccount recognizes; the password field is genuinely arbitrary —
      // any string here passes exactly the same way.
      const body = isConsent
        ? new URLSearchParams({ prompt: 'consent' })
        : new URLSearchParams({ prompt: 'login', login: SEEDED_SUBJECT, password: 'this-password-is-never-checked' });

      const submitRes = await fetch(`${ISSUER}/interaction/${uid}`, {
        method: 'POST',
        redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: cookieHeader(jar) },
        body: body.toString(),
      });
      mergeCookies(jar, submitRes);
      const location = submitRes.headers.get('location');
      if (!location) throw new Error('interaction submit returned no redirect');
      next = new URL(location, ISSUER).href;
      continue;
    }

    const body = await res.text();
    throw new Error(`unexpected response ${res.status} at ${next}\n${body.slice(0, 2000)}`);
  }

  throw new Error('too many redirects driving the login flow');
}

function fail(message: string): never {
  console.error(`\nFAIL — ${message}\n`);
  process.exit(1);
}

async function main() {
  console.log(`\n=== A-1 verify: real OIDC round trip against ${ISSUER} ===\n`);

  const adapter = new OidcIdentityProviderAdapter({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    allowInsecureRequests: true, // dev-idp is plain HTTP, locally, only
  });

  // ---- 1. Real login round trip ----
  const authReq = await adapter.createAuthorizationRequest();
  console.log('1. Authorization request built:');
  console.log(`   state=${authReq.state}`);
  console.log(`   nonce=${authReq.nonce}`);

  const callbackUrl = await driveBrowserThroughLogin(authReq.url);
  console.log(`   simulated browser reached callback: ${callbackUrl.href}`);

  const identity = await adapter.completeAuthorizationCodeFlow({
    callbackUrl,
    expectedState: authReq.state,
    expectedNonce: authReq.nonce,
    codeVerifier: authReq.codeVerifier,
  });
  console.log(`   VERIFIED subject: ${identity.subject}`);
  console.log(`   VERIFIED claims: ${JSON.stringify(identity.claims)}`);
  if (identity.subject !== SEEDED_SUBJECT) {
    fail(`expected subject ${SEEDED_SUBJECT}, got ${identity.subject}`);
  }
  console.log('   PASS — real id_token verified, subject matches the seeded account\n');

  // ---- 2. Tampered id_token signature ----
  // Tampers at the transport layer (openid-client's documented customFetch
  // hook) so the exact same authorizationCodeGrant() call our adapter makes
  // receives a genuinely corrupted signature from the real token endpoint —
  // not a different flow/function than production code uses.
  console.log('2. Tampering with id_token signature...');
  {
    const authReq2 = await adapter.createAuthorizationRequest();
    const callbackUrl2 = await driveBrowserThroughLogin(authReq2.url);

    // enableNonRepudiationChecks: see oidc-identity-provider.adapter.ts's
    // getConfiguration() comment — without it, oauth4webapi does not
    // cryptographically verify the id_token signature for the direct
    // authorization_code exchange at all (OIDC Core §3.1.3.7 lets TLS
    // substitute for it, which does not hold over our plain-HTTP dev-idp).
    const config = await client.discovery(new URL(ISSUER), CLIENT_ID, undefined, undefined, {
      execute: [client.allowInsecureRequests, client.enableNonRepudiationChecks],
    });
    config[client.customFetch] = async (...args: Parameters<typeof fetch>) => {
      const res = await fetch(...args);
      const url = typeof args[0] === 'string' ? args[0] : args[0] instanceof URL ? args[0].href : (args[0] as Request).url;
      if (!url.includes('/token')) return res;

      const json = (await res.json()) as { id_token?: string };
      if (json.id_token) {
        const parts = json.id_token.split('.');
        const sig = parts[2];
        const flippedChar = sig.at(-2) === 'A' ? 'B' : 'A'; // -1 may be base64url padding-sensitive; flip second-to-last
        parts[2] = sig.slice(0, -2) + flippedChar + sig.slice(-1);
        json.id_token = parts.join('.');
        console.log(`   (intercepted token response, corrupted id_token signature: ...${sig.slice(-8)} -> ...${parts[2].slice(-8)})`);
      } else {
        console.log('   (WARNING: token response had no id_token field to tamper)');
      }
      // Fresh headers, not res.headers — the original Content-Length would
      // mismatch our (possibly different-length) rebuilt body.
      return new Response(JSON.stringify(json), {
        status: res.status,
        headers: { 'content-type': 'application/json' },
      });
    };

    try {
      const tampered = await client.authorizationCodeGrant(config, callbackUrl2, {
        expectedState: authReq2.state,
        expectedNonce: authReq2.nonce,
        pkceCodeVerifier: authReq2.codeVerifier,
        idTokenExpected: true,
      });
      // Signature verification happens on .claims() — the same call our real
      // adapter's completeAuthorizationCodeFlow makes.
      const claims = tampered.claims();
      fail(`tampered id_token signature was accepted — should have thrown (got claims: ${JSON.stringify(claims)})`);
    } catch (err) {
      console.log(`   REAL FAILURE (expected): ${(err as Error).name}: ${(err as Error).message}`);
      console.log('   PASS — tampered signature rejected\n');
    }
  }

  // ---- 3. Replayed state ----
  console.log('3. Replaying a state value from a previous flow...');
  {
    const authReq3 = await adapter.createAuthorizationRequest();
    const callbackUrl3 = await driveBrowserThroughLogin(authReq3.url);
    try {
      await adapter.completeAuthorizationCodeFlow({
        callbackUrl: callbackUrl3,
        expectedState: authReq.state, // WRONG — this is flow #1's state, not #3's
        expectedNonce: authReq3.nonce,
        codeVerifier: authReq3.codeVerifier,
      });
      fail('replayed/mismatched state was accepted — should have thrown');
    } catch (err) {
      console.log(`   REAL FAILURE (expected): ${(err as Error).name}: ${(err as Error).message}`);
      console.log('   PASS — mismatched state rejected\n');
    }
  }

  // ---- 4. Mismatched nonce ----
  console.log('4. Using a mismatched nonce...');
  {
    const authReq4 = await adapter.createAuthorizationRequest();
    const callbackUrl4 = await driveBrowserThroughLogin(authReq4.url);
    try {
      await adapter.completeAuthorizationCodeFlow({
        callbackUrl: callbackUrl4,
        expectedState: authReq4.state,
        expectedNonce: 'this-is-not-the-real-nonce',
        codeVerifier: authReq4.codeVerifier,
      });
      fail('mismatched nonce was accepted — should have thrown');
    } catch (err) {
      console.log(`   REAL FAILURE (expected): ${(err as Error).name}: ${(err as Error).message}`);
      console.log('   PASS — mismatched nonce rejected\n');
    }
  }

  console.log('=== all 4 checks passed ===\n');
}

main().catch((err) => {
  console.error('verify-a1-oidc-roundtrip crashed:', err);
  process.exit(1);
});
