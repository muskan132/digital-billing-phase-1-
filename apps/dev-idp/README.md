# apps/dev-idp

The local OpenID Provider for Phase 4's merchant portal auth (D-52). A small
`oidc-provider`-based server, run as its own workspace app — never a
production dependency of `apps/api` (D-53). Started automatically by
`pnpm dev:up` (`scripts/dev-up.ps1`), listening on `:9000`.

## Scope boundary — read before assuming a login here proves anything (D-54)

`oidc-provider`'s `devInteractions` feature (its built-in dev login screen)
accepts **any username and any password**. Proof, not assertion: the
library's own `lib/actions/interaction.js` `interactionSubmit` handler reads
only `ctx.oidc.body.login` for the login prompt — `ctx.oidc.body.password`
is never read anywhere in that handler, even though the rendered form
requires one. There is no credential store behind this process, locally, at
all.

| Exercised locally, genuinely | **Not** exercised locally, at all |
|---|---|
| RP protocol handling: discovery, PKCE, `state`, `nonce`, JWKS-verified `id_token` issuance | **Whether the person logging in is who they claim to be.** No password is checked, no MFA, no lockout, no rate limit |
| Our own authorization gates once A-2–A-5 land (eligibility, per-request re-check, role gate, cross-tenant 404) | Anything a real IdP would enforce: credential strength, account lockout, session policy, MFA |

A green A-1/A-2 run against this process means **"the RP handles the
protocol correctly and our authorization gates work."** It does **not**
mean authentication works. That guarantee is entirely inherited from
whichever real IdP D-42's open sign-off eventually names — this process is
a stand-in for that IdP's *protocol shape*, never for its credential
verification.

## Seeded subjects (what to type at the login screen)

`findAccount` accepts **any** subject value the login form submits (see the
scope boundary above) — restricting it would make it impossible to test
`apps/api`'s own rejection paths (unknown subject, ineligible type, disabled
user). These are just the two values `apps/api/prisma/seed.ts` provisions a
real `User` row for:

| Type this as the username | Resolves to | Role |
|---|---|---|
| `seed-user-merchant-admin` | the seeded `MERCHANT_ADMIN` (A-2) | `MERCHANT_ADMIN` |
| `seed-user-store-staff` | the seeded `STORE_STAFF` (A-6 / D-50) | `STORE_STAFF` |

The password field is ignored (D-54). Any other value logs in at the IdP but
`apps/api` rejects the callback with `403` (no matching `User`).

## Never runs in production

`src/main.ts` refuses to start if `NODE_ENV=production` (D-53). This package
has no `build` script — there is nothing here to ship.
