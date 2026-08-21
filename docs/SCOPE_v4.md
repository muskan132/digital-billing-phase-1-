# SCOPE v4 — Merchant self-service portal

Phase 4 **extends** v1/v2/v3; it replaces nothing. The callback path, the direct API, the public bill page, the renderer, the broadcast queue, and every `/demo` route keep working exactly as they do today. This phase adds the first surface where **"which merchant is this?" is answered by a real session instead of a seed constant** (D-38's named prerequisite), and moves the Phase-3 builder behind it.

Two auth questions live here and they are **not the same question**. `rbac.md` names three principal classes; C1 as recorded in `PENDING_WORK.md` is about a *calling system* (`POST /v1/bills`), while this portal is about a *human user*. They get separate answers — D-41, D-42.

## In scope

1. **Merchant login** — OIDC Relying Party against an external IdP; the portal stores no password. Local runs use a dev OP as a workspace app, not a container (D-42, D-52), so the shipped code path is the production code path. **It verifies no credentials — see D-54.**
2. **Session management** — opaque server-issued session token, hashed at rest in a new `MerchantSession` table, delivered as an `HttpOnly` cookie; explicit logout and revocation; CSRF defence on every state-changing route (D-44, D-45).
3. **`MerchantContext` resolver** — one seam that answers "which merchant is this request for". `SessionGuard` resolves it from the session; `DemoOnlyGuard` resolves it from `SEED_MERCHANT_ID`. Services take `merchantId` as an argument and never read the environment (D-46).
4. **Bill history view** — the merchant's own bills, both `PG_CALLBACK` and `DIRECT_API` sourced, discriminated by `Order.source`. Filters: date range, `billType`, `source`. **Keyset pagination**, never offset. Merchant-scoped in the query, re-checked at the data layer.
5. **Bill detail view** — one bill, including the **merchant-visible customer contact projection** — a new, distinct PII boundary, not a relaxation of D-17/D-28 (D-48).
6. **Dashboard** — the authenticated home: template list, create-invoice, links into history and the builder. Same components the `/demo` panel uses; a second, authenticated route into them.
7. **The Phase-3 builder, reachable under `/portal`** — same components, same services, `merchantId` from the session instead of the seed. The demo route stays.
8. **Role gates written at the guard** per `rbac.md` §Roles, even though only one `MERCHANT_ADMIN` user is seeded (D-50).

## Explicitly out of scope — deferred, **not designed**

- **Self-serve signup / onboarding / KYC.** Merchant accounts and their `User` rows are provisioned by seed or by an out-of-band admin action. This phase is logging *in*, not signing *up*.
- **Password reset, MFA enrolment, account recovery.** These belong to the IdP, which is exactly why D-42 chooses an IdP rather than local credentials. MFA policy is an IdP configuration question, not code here.
- **Merchant user management** (invite, remove, assign roles, store assignments). The schema already holds N users per merchant; this phase seeds one and builds no UI (D-50).
- **Platform billing / subscription.** Out entirely.
- **Admin and Support portals.** `User.type = INTERNAL` principals are **rejected** by this portal's guard — a different portal, a different auth model, a different session domain (`portals.md`).
- **Resend, credit notes, analytics panels, customer list, delivery preferences** (FSD 6.4/6.5) — read-only history and the existing builder only.
- **Bulk export / CSV download** of history. It is a PII-export surface and `security.md` requires it audited; no audit table exists.
- **Redis sessions, a BFF tier, short-lived JWT-to-BFF** (Blueprint §7.1's target shape). Postgres-backed sessions behind a port; the swap is a storage adapter, not a redesign.
- Every pre-existing pre-production blocker is unchanged and this phase fixes none of them: the Prisma `P2002` race, PII in Prisma-thrown errors, `TAX_COMPLIANT`'s two rendering bugs, the missing `invoiceDate`, the unverified inter-state IGST render.

## The flow

```
/portal/*  (SessionGuard)
  GET /portal/login -> redirect to IdP (OIDC authorization code + PKCE)
     <- /auth/callback: verify id_token -> find User by `subject`
        (User.type=EXTERNAL, merchantId NOT NULL, disabledAt NULL) --else--> 403, no session
        -> INSERT MerchantSession(tokenHash, userId, expiresAt) -> Set-Cookie (HttpOnly, SameSite=Lax)
  |
  +-- every /portal request: cookie -> sha256 -> MerchantSession lookup
        -> not found / expired / revoked / user disabled -> 401, cookie cleared
        -> MerchantContext { userId, merchantId, role }        (D-46)
  |
  +-- GET /portal/bills      -> keyset page of the session merchant's bills; contact MASKED
  +-- GET /portal/bills/:id  -> one bill; contact IN FULL (D-48); 404 if not this merchant
  +-- /portal/templates/*    -> the Phase-3 builder, merchantId from context
  +-- POST *                 -> CSRF token required (D-44)
  +-- POST /portal/logout    -> MerchantSession.revokedAt = now(), cookie cleared

/demo/*  (DemoOnlyGuard, unchanged)  -> MerchantContext { merchantId: SEED_MERCHANT_ID }  (D-46)
```

## Definition of "done" (local UAT passes)

- Log in through the local IdP → a `MerchantSession` row exists, its `tokenHash` is **not** the cookie value, and the cookie is `HttpOnly`; `grep` the repo for the raw token in any log line returns nothing.
- Log out → the same cookie replayed returns `401` and **the row is still there** with `revokedAt` set (revocation is a state, not a delete).
- An `INTERNAL` user, a `User` with `merchantId = NULL`, and a `disabledAt` user each reach the IdP successfully and are still refused a session, with **no session row written**.
- **Cross-merchant probe:** seed a second merchant with one bill and one template. Every `/portal` endpoint asked for that merchant's `billId` / `templateId` returns **404, never 403** — the same precedent as the demo gate (D-47). `SELECT` counts unchanged.
- History lists bills from **both** sources; filtering by `source=DIRECT_API` excludes PG-sourced rows and vice versa; the same page requested twice with the same cursor returns identical rows, and a bill created between two page fetches never causes a skipped or repeated row.
- List response contains **masked** contact only; detail response contains full contact and **exactly** the D-48 field set — a key-set test fails if any field outside it appears.
- `Bill.snapshot` is byte-identical to before this phase for every existing bill; **D-17/D-28's whitelist is not extended by one field** (D-48 is a separate projection built in the portal DTO, not in `snapshot`).
- A `POST` to any `/portal` route without the CSRF token → rejected, zero writes. With a valid session cookie sent cross-origin from a different origin's form → rejected.
- `SEED_MERCHANT_ID` appears in **exactly one** file after A-4 (`grep -r SEED_MERCHANT_ID src/` proves it); `templates.service.ts` and the builder read it nowhere.
- The builder works identically at `/portal/templates` and `/demo/templates`, forking against the *session's* merchant on the authenticated route; the Phase-3 immutability regression (X-2) is still green.
- `/portal/*` returns normal auth behaviour with the demo gate **off** — the portal is not demo-gated.
- Every v1, v2, and v3 test still green. No money path touched. No change to `Bill.layoutSnapshot`, the renderer, or the public bill page.
