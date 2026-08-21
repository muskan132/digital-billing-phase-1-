// apps/dev-idp — the local OpenID Provider (D-52). A separate workspace app,
// never built for production (D-53): `oidc-provider` is a dependency of THIS
// package only, never of apps/api.
//
// D-54 — SCOPE BOUNDARY, read before touching anything below:
// `devInteractions` (oidc-provider's built-in dev login screen) accepts ANY
// username and ANY password. Proof, not assertion: oidc-provider's own
// lib/actions/interaction.js `interactionSubmit` handler reads only
// `ctx.oidc.body.login` for the login prompt — `ctx.oidc.body.password` is
// never read anywhere in that handler, even though the rendered form requires
// one. There is no credential store behind this process, locally, at all.
// What this DOES genuinely exercise: OIDC discovery, PKCE, `state`/`nonce`,
// JWKS-verified `id_token` issuance, and our own authorization gates once A-2
// through A-5 land. What it does NOT exercise, at all: whether the person
// logging in is who they claim to be. A green A-1/A-2 means the protocol and
// our own authorization work — never that authentication happened. See D-54.
import { createServer } from 'node:http';
import Provider from 'oidc-provider';

if (process.env.NODE_ENV === 'production') {
  throw new Error(
    'apps/dev-idp must never run with NODE_ENV=production (D-53) — it has no real credential store. ' +
      'A real deployment points the IdentityProvider port at a real IdP; this process is dev-only tooling.',
  );
}

const PORT = Number(process.env.DEV_IDP_PORT ?? 9000);
const ISSUER = process.env.DEV_IDP_ISSUER ?? `http://localhost:${PORT}`;
const REDIRECT_URI = process.env.DEV_IDP_REDIRECT_URI ?? 'http://localhost:4000/auth/callback';

// Matches apps/api/prisma/seed.ts's seeded MERCHANT_ADMIN User id — A-2 is
// what actually resolves this subject to a real User row. This file has no
// import of, or awareness of, the User table itself.
const SEEDED_SUBJECT = 'seed-user-merchant-admin';

const oidc = new Provider(ISSUER, {
  clients: [
    {
      client_id: 'digital-billing-portal',
      client_name: 'Digital Billing Portal (dev)',
      redirect_uris: [REDIRECT_URI],
      response_types: ['code'],
      grant_types: ['authorization_code'],
      token_endpoint_auth_method: 'none', // public client — PKCE is mandatory below, not optional
    },
  ],
  pkce: {
    required: () => true,
  },
  features: {
    devInteractions: { enabled: true }, // default in 9.11.3 — explicit per D-54, not relied on silently
  },
  claims: {
    openid: ['sub'],
  },
  findAccount(_ctx, sub) {
    if (sub !== SEEDED_SUBJECT) {
      return undefined;
    }
    return {
      accountId: sub,
      async claims() {
        return { sub };
      },
    };
  },
});

oidc.on('server_error', (_ctx, err) => {
  console.error('[dev-idp] server_error:', err);
});

const server = createServer(oidc.callback());
server.listen(PORT, () => {
  console.log(`[dev-idp] listening at ${ISSUER} (seeded subject: ${SEEDED_SUBJECT})`);
});
