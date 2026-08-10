# DECISIONS v1 — only what was actually decided

### D-1 · Template storage & structure
**Decision:** store each template as one ordered JSONB array of typed blocks — `layoutSchema: [{ "type": "HEADER"|"ITEMS"|..., "order": N, "props": {...} }]` — validated against a block-type enum/JSON-schema before write.
**Reason:** the renderer maps `block.type → partial` and iterates by `order`; zero joins, and it matches the project's existing "templates are logic-less data / `layout_schema` JSONB" precedent (TDS §data-dictionary).
**Runner-up:** a normalized `template_blocks(template_id, position, type, props)` table — more per-block constraints/queryability, but adds a join + ordering upkeep for no v1 benefit. (Rejected outright: storing raw HTML/Handlebars — injection surface, violates logic-less rule.)

### D-2 · Money type
**Decision:** integer **paise** as `BigInt` (`_paise` suffix). Convert JioPay's rupee **string** `"1.00"` → paise via decimal/string parse; **never** `parseFloat * 100`.
**Reason:** floats corrupt money; matches TDS §1 and prisma.md (lint-enforced no-float). This is a T1 money path — happy/duplicate/parse-edge cases must be tested and the total must reconcile to the callback amount.

### D-3 · Stub strategy (broadcast)
**Decision:** SMS/email are not sent to any vendor. A `Broadcast` row is written (`SENT`/`FAILED`) plus a log line; email is delivered to **Mailhog** over local SMTP.
**Reason:** step 4 needs a broadcast *record and observable artifact* for UAT without vendor onboarding; the adapter seam stays so a real provider drops in later behind the same port.

### D-4 · Single Postgres, synchronous (v1 only)
**Decision:** collapse the old KV Bill Store / multi-store / Kafka design into **one Postgres via Prisma**, synchronous request path.
**Reason:** the slice must run locally to pass local UAT; the store split and event backbone add no UAT value. Deviation from prisma.md ("never model the Bill Store in Prisma") is **deliberate and v1-scoped** — re-evaluate before any non-local target.

### D-5 · Duplicate-callback response
**Decision:** a redelivered/duplicate callback is acknowledged with **`200`** (no-op upsert) — **never `409`**. Enforcement is `UNIQUE(txnId)` + upsert (D-8/D-9); `idempotencyKey = "PG:" + merchantTxnNo + "#" + paymentID` is a non-unique audit value only.
**Reason:** JioPay S2S is at-least-once; any non-2xx tells JioPay the callback failed and triggers **more** retries, so a duplicate must ack success, not error.

### D-6 · Broadcast decoupling (the table *is* the queue)
**Decision:** on a successful callback, the Order, Bill, **Link**, and a `Broadcasts` row with `status=PENDING` are written in a **single transaction**. The link never depends on the broadcast succeeding — the request path only *enqueues* (writes PENDING); it never sends inline. The `Broadcasts` table **is** the queue (no Kafka/Redis); the drainer is a **NestJS scheduled job** that picks the oldest `PENDING` row (**FIFO by `createdAt`**).
**Reason:** decoupling keeps the customer-facing link/bill available even if delivery is down; a DB table gives FIFO + durability + at-least-once with zero new infrastructure for a local slice.

### D-7 · Failure policy (no head-of-line blocking)
**Decision:** worker processes FIFO, but a failed send sets `status=FAILED`, `attempts++`, and records `error`; the item is **retried on a later pass** up to a max attempt count, gated by a backoff table indexed by `attempts` (`[10s, 30s, 60s, 120s, 300s]`) measured since `Broadcast.updatedAt` — a `FAILED` row is only eligible again once its window has elapsed. A failed item **does not block** the items behind it — the worker skips non-eligible rows and keeps draining.
**Reason:** one bad recipient (or a flaky stub) must not stall the whole queue; bounded retries prevent infinite reprocessing. (Max-attempts value is a knob — see GAPS.) With the default 5-attempt budget, the backoff table sums to ~520s, so the queue now tolerates **roughly 8–9 minutes** of downstream outage before permanently abandoning a notification — not the ~50 seconds the original unthrottled every-10s-tick retry allowed.

### D-8 · Idempotency via UNIQUE(txnID) + upsert
**Decision:** JioPay S2S callbacks are **at-least-once** (the same callback can arrive twice). Enforce `UNIQUE(txnID)` on `Order` and make callback processing an **upsert on `txnID`** inside the D-6 transaction, so a redelivered callback creates no duplicate order, link, or broadcast.
**Reason:** at-least-once delivery demands an idempotent write; `txnID` is JioPay's per-transaction identifier and the natural upsert key. **Supersedes D-5's mechanism:** enforcement moves from reject-and-return-existing on `idempotencyKey` to upsert-on-`txnID`; `idempotencyKey` remains only as a derived audit value.

### D-9 · txnId is the sole idempotency key
**Decision:** `txnId @unique` is the only idempotency enforcement key; `idempotencyKey` is demoted to a plain **non-unique** audit column, and P-1 upserts on `txnId` only.
**Reason:** `txnId` is the identifier JioPay guarantees stable across redeliveries; a second unique constraint on `idempotencyKey` was a redundant, independent failure mode (a replay could satisfy one key and violate the other). One key, one enforcement path.

### D-10 · Template block-type enum
**Decision:** `layoutSchema` block types are limited to this fixed set for v1: `HEADER`, `MERCHANT_INFO`, `ITEMS`, `PAYMENT_DETAILS`, `TOTAL`, `FOOTER`. Any other type value is invalid and must be rejected by both the seed data and V-1's renderer.
**Reason:** D-1 specified the `layoutSchema` shape but not concrete type values; this is needed now so S-5's seeded templates and V-1's renderer agree on the same enum. Kept minimal — enough to render a receipt/tax invoice, nothing speculative added. `PAYMENT_DETAILS` was added post-demo to carry payment-method content so `ITEMS` stays reserved for genuine line items (needed as-is for the Tax Invoice path). This enum is expected to grow further — the FSD's block palette also includes engagement blocks (`COUPON`, `SURVEY`, `MARKETING`) not yet built here.

### D-11 · Broadcast channel selection
**Decision:** `Merchant.defaultChannel` (`Channel` enum, default `EMAIL`) determines the channel for the PENDING Broadcast P-1 creates. No per-order override in v1 (the merchant-portal invocation flow that would allow this is deferred).
**Reason:** EMAIL is visible in Mailhog for UAT; SMS is log-only and produces no visual confirmation. One field on Merchant is enough since v1 has no invocation-time UI to override it.

### D-12 · Missing-recipient policy
**Decision:** if the PII field for `Merchant.defaultChannel` is null/absent on a given callback, P-1 still commits Order + Bill + Link in the transaction, but creates NO Broadcast row for that order. Order/Bill/Link creation must never depend on a recipient being available. Log this case (masked).
**Reason:** preserves D-6's intent literally — the link's existence must never depend on anything about the broadcast, including whether one is even possible.

### D-13 · Bill type & template selection source
**Decision:** P-1 derives both `Bill.billType` and `Bill.templateId` from the order's `Merchant.defaultTemplate` (and that template's own `billType` field). No per-order override in v1.
**Reason:** the seed already sets `Merchant.defaultTemplateId` with exactly this intent; this makes it authoritative. Note: the seeded Tax Invoice template is therefore inert/unreachable in v1 — expected, not a bug.

### D-14 · P-1 edge cases (config errors, malformed txnId, no reconciliation)
**Decision:** three edge cases in P-1's persist-on-success path, each resolved by extending an existing decision's logic:
(a) Missing `Merchant.defaultTemplate` on a `0000` callback: commit Order (`status=SUCCESS`) alone via the same upsert/no-op-on-replay pattern; skip Bill, Link, AND Broadcast (a Link with no Bill is a dead end for rendering); log masked as a config error needing ops attention.
(b) Missing/empty `txnId` on a `0000` callback: cannot upsert (no key to write on) — skip persistence entirely, log masked, still respond `200` (per D-5's logic: retrying an unwritable payload forever helps no one).
(c) A `txnId` that later arrives with a different `responseCode` than its first delivery is NOT reconciled — `update: {}` means the first-seen status is permanent for that `txnId`, per D-8/D-9 treating redelivery as the same event repeating, not a status transition. Accepted as a known v1 limitation, not built.
**Reason:** each extends an existing decision's precedent (D-12 for a/b's "can't-complete-write, don't fail the callback" pattern; D-5 for the retry-loop logic; D-8/D-9's redelivery model for c) rather than introducing new logic — keeping P-1's edge-case handling consistent with the rest of the system rather than ad hoc.

### D-15 · Unparseable amount on a 0000 callback
**Decision:** if `responseCode` is `"0000"` but the amount string fails `rupeesToPaise()` validation, do not persist Bill/Link/Broadcast and do not fail the request — commit `Order(status=SUCCESS, amountPaise=null)` via the same upsert/no-op-on-replay pattern, log masked as a config/contract error needing ops attention, respond `200`. Extends D-14(a)/(b)'s pattern: an unwritable payload is never retried, since retrying changes nothing.
**Reason:** JioPay is at-least-once; a non-2xx here means infinite retries of a payload that will never become parseable. A billing system that can't parse the amount on a successful payment has a config/contract problem, not a transient one.

### D-16 · Money regex requires exactly 2 decimal digits
**Decision:** `rupeesToPaise()`'s pattern is `^\d+\.\d{2}$` (was `\d{1,2}`) — a single-decimal string like `"1.0"` is rejected, same as `"1000"` and `"1.005"`.
**Reason:** one consistent rule (exactly 2 decimals or reject) is safer than a partial-decimal exception that was accepted by the regex but never tested, which could have silently produced a 10x money error.

### D-17 · Bill.snapshot is a whitelisted, non-PII projection
**Decision:** `Bill.snapshot` (written by P-1) may only ever contain the following fields, or other explicitly non-PII, publicly-safe fields added with the same scrutiny: `merchantName`, `amountPaise`, `currency`, `paymentMode`, `paymentDateTime`, `receiptNumber` (JioPay `txnID`), `merchantTxnNo`, `cardNetwork`, `paymentInstId`, `respDescription`. This is a Tier-1 change: adding any field to what P-1 writes into `snapshot` requires the same scrutiny as touching PII handling directly, because L-2's whitelist (a Prisma `select`) cannot filter inside a JSON column — L-2's public-safety guarantee is only as good as what P-1 puts in this field.
`paymentInstId` is conditional: JioPay only confirms it pre-masked (e.g. `"4XXX XXXX XXXX 1111"`) for card transactions. For other payment modes (e.g. UPI) it may carry the customer's VPA, which is PII. P-1 only includes its value when `cardNetwork` is present (confirming a card transaction); otherwise it is stored as `null`. The key is always present — only the value is conditional — so the key-set enforcement test is unaffected by payment mode.
**Reason:** found during the Link+Render CTO review — the existing safeguard was a comment in the file that READS `snapshot` (`links.service.ts`), not the file that WRITES it (`callbacks.service.ts`), so a future edit to P-1 could add a PII field without anyone seeing the warning that mattered. Enforced by a test (see B-1 prep), not just this doc entry, since a comment doesn't fail a build. Extended post-demo to carry enough fields (`receiptNumber`, `merchantTxnNo`, `cardNetwork`, `paymentInstId`, `respDescription`) for a proper RECEIPT layout, each individually confirmed non-PII (`paymentInstId` conditionally, per above).

---
# Phase 2 — Direct merchant API (POST /v1/bills)

### D-18 · The direct API path also creates an Order (Option A)
**Decision:** `POST /v1/bills` writes an `Order` row exactly as the callback path does. `Order.txnId` becomes nullable; a new `Order.externalTransactionId` gets its own unique constraint; `Order.source` (`PG_CALLBACK`|`DIRECT_API`) records the path. Bill, OrderItem, Link, and Broadcast all continue to hang off Order, created as nested writes inside the upsert's `create` branch with `update: {}` — the identical pattern P-1 uses. `Order` now means "a sale", from either path.
**Reason:** v1's hard-won correctness — replay safety, L-2's whitelist boundary, the broadcast queue — is all keyed on Order. Reparenting to Bill would put every one of those back in play to buy semantic tidiness.
**Runner-up:** make `Bill` the root and let Order be a payment-path-only detail. Rejected: correct-looking refactor, re-opens four verified invariants, zero functional gain.

### D-19 · Direct-API auth: per-merchant API key behind a guard seam
**Decision:** `ApiKeyGuard`, structurally the same seam as `SecureHashGuard`. Credential lives in a new `MerchantApiKey` table (not a column, and **not** `Merchant.secretKeyEnc`): `keyPrefix` plaintext for lookup, `keyHash` = SHA-256 of the full key, constant-time compare, `status` for revocation. `merchantId` is taken from the resolved key, never from the body; a body `merchant_id` that disagrees → `403` (BR-15).
**Reason:** a table rather than a column because rotation requires two keys live at once; a column forces a hard cutover. Separate from `secretKeyEnc` because the PG HMAC secret has a different purpose, blast radius, and rotation lifecycle — one compromise must not imply the other.
**PRE-PRODUCTION BLOCKER:** the real auth model (API key vs OAuth2 client-credentials vs mTLS) is an unresolved FSD §10 open question owned by Eng + Security, and Blueprint ADR-7 already prefers OAuth2 client-credentials. This decision is demo-scoped. The guard seam is the entire point: swapping it must not touch controllers or callers.

### D-20 · Invoice number is caller-supplied
**Decision:** `invoice_number` is a **required** field on the direct payload for `TAX_INVOICE`. The core validates presence and per-merchant uniqueness (`@@unique([merchantId, invoiceNumber])`) and stores it. The core generates no sequence.
**Reason:** additive-safe. Making a required field optional and generating a number later is a one-way-compatible change; unwinding two competing sequences (merchant POS and core) after both have issued numbers is not.
**PRE-PRODUCTION BLOCKER:** GST requires a gap-free sequential series per issuer per financial year. Whether the core should own it is an FSD §10 open question owned by Product + Compliance. Caller-supplied means **the merchant owns the sequence and its gaps** — that is a liability allocation, not just a design choice, and must be stated in the integration contract.

### D-21 · The caller is the tax authority; the core only validates
**Decision:** the caller supplies every tax figure (per-line `tax_rate_bp`, per-line tax, the CGST/SGST/IGST block, the grand total). The core recomputes and compares, and **rejects on mismatch — it never silently corrects and never originates a rate**. There is no tax-rate table in the core.
**Reason:** confirmed by the TDS ("recompute … equality in paise; mismatch → 422, no write"). The merchant is the legal issuer of the invoice and owns the liability; a core that quietly rewrote a merchant's tax figures would be assuming that liability invisibly. FSD §10 lists rate authority as an open question — this decision answers it in the only direction the TDS supports.

### D-22 · Calculation validation algorithm (exact order)
**Decision:** for `TAX_INVOICE` only, compute in this order, entirely in `BigInt` paise and integer basis points:

1. **Line gross** — for each line `i`: `gross[i] = quantity[i] * unitPricePaise[i]`. Reject if `quantity < 1` or `unitPricePaise < 0`.
2. **Item discount** — `afterItem[i] = gross[i] - itemDiscountPaise[i]`. Reject if `itemDiscountPaise[i] > gross[i]` (a negative line is rejected outright per FSD 5.2 — corrections are credit notes, BR-2).
3. **Subtotal** — `subtotal = Σ gross[i]`. Compare to supplied `subtotal_paise`.
4. **Bill-level discount allocation** — allocate `billDiscountPaise` across lines per **D-23**, giving `alloc[i]`. Reject if `billDiscountPaise > Σ afterItem[i]`.
5. **Taxable value** — `taxable[i] = afterItem[i] - alloc[i]`. Invariant: `Σ taxable[i] == subtotal - Σ itemDiscount[i] - billDiscount`.
6. **Tax per line** — `tax[i] = halfUp(taxable[i] * taxRateBp[i], 10000)` per **D-24**. Split into CGST/SGST or IGST per **D-25**.
7. **Grand total** — `total = Σ taxable[i] + Σ tax[i]`.
8. **Compare** — every one of `subtotal`, `discount`, `tax`, `cgst`, `sgst`, `igst`, `total` must equal the supplied value **exactly, in paise**. Any mismatch → `422 CALC_MISMATCH {field, expected, supplied}`, **no write of any kind**.

**Reason:** tax is computed on the post-discount value because a discount recorded on the face of the invoice reduces the taxable value — so the discount must be fully resolved (item, then bill-level) before any tax is computed. This is what "recompute item-order discounts then bill-level" in the TDS means, made unambiguous. Computing tax before the bill-level discount would overstate output tax.
**Assumption flagged for Compliance:** the treatment in step 6 (discounts shown on the invoice reduce taxable value) is the standard reading of CGST Act s.15(3)(a), but it is *our* reading, not something the FSD states. Confirm before production.

### D-23 · Bill-level discount is allocated proportional to post-item-discount line value, with largest-remainder
**Decision:** `alloc[i] = floor(billDiscount * afterItem[i] / Σ afterItem)`. The residual `billDiscount - Σ alloc[i]` (always `< lineCount` paise) is then distributed one paise at a time to lines ordered by **descending fractional remainder**, ties broken by **ascending `lineNo`**. Persisted per line as `OrderItem.billDiscountAllocPaise`.
**Reason:** the spec is genuinely silent here, and it matters only because lines can carry different tax rates — any allocation that isn't value-proportional shifts money between rate buckets and changes the tax owed. Proportional-to-value is rate-neutral: it leaves each line's effective tax rate exactly where it was. Largest-remainder is chosen over "dump the residual on line 1" because it is deterministic, order-stable, and reproducible by the caller from the published rule — which matters, because the caller has to arrive at the same number or get a 422.
**Runner-up:** allocate the discount to the lowest-taxed lines first, minimising output tax. Rejected — it is tax engineering the merchant did not ask for, it is not defensible in an audit, and no caller would independently reproduce it.

### D-24 · Rounding: half-up, per line, never on the total
**Decision:** `tax[i] = (taxable[i] * taxRateBp[i] + 5000n) / 10000n` using `BigInt` division (which truncates; all values are non-negative, so `+ half-divisor` yields half-up). Rounding happens **once per line**. The bill-level tax total is the **sum of already-rounded line taxes** — it is never independently computed from the subtotal.
Within a line, the CGST/SGST split is `cgst[i] = (tax[i] + 1n) / 2n` and `sgst[i] = tax[i] - cgst[i]`. The second half is derived by **subtraction, not by rounding a second time**.
**Reason:** per-line because a tax invoice prints a tax amount per line, and those printed figures must add up to the printed total — rounding once on the total guarantees they eventually won't. Half-up because it is conventional commercial rounding and what POS systems implement, so caller and core agree. Split-by-subtraction because rounding both halves independently can create or destroy a paise on odd tax amounts; this is the exact class of bug that produces a one-paise `CALC_MISMATCH` on a correct invoice.
**Test obligation (T1):** the rounding edges — a tax ending exactly on `.5` paise, an odd line tax split across CGST/SGST, mixed rates in one bill, a bill-discount residual smaller than the line count — are unit-tested cases, not incidental coverage.

### D-25 · Place of supply: caller-supplied 2-digit state code, compared to `Merchant.gstStateCode`
**Decision:** the payload carries `place_of_supply` as a **2-digit GST state code** string (e.g. `"27"`), at bill level, not per line. Comparison: `place_of_supply == Merchant.gstStateCode` → **CGST + SGST** (each half the line tax, per D-24); otherwise → **IGST** (the full line tax). The choice is derived by the core, not taken from the caller; if the caller's supplied `tax_block` contradicts the derived shape (e.g. supplies `igst_paise` on an intra-state bill), that is a `422`, not a silent correction. `Merchant.gstStateCode` and `Merchant.gstin` must both be present or the request is `422 GST_FIELD_MISSING` — and `Merchant.gstStateCode` must equal `gstin[0:2]`, checked at seed and at validation.
**Reason:** the numeric code is the only unambiguous, machine-comparable form — state *names* have spelling and union-territory variants that cannot be validated — and it cross-checks against the merchant's own GSTIN for free, since the GSTIN's first two characters are that same code.
**Correction to the brief:** `Merchant.gstin` did **not** exist in `DATA_MODEL_v1.md` and was added in the post-demo merchant-profile task, ahead of Phase 2. `Merchant.state` also already existed by then, but as a **display-name field for the receipt address block** (unrelated to GST) — reusing it here would have made one column mean two incompatible things. `Merchant.gstStateCode` is a distinct new field added specifically for this purpose in S-7, leaving `Merchant.state` and the receipt renderer untouched.

### D-26 · A zero-rated line is valid; HSN is required regardless
**Decision:** `taxRateBp = 0` is a valid rate and produces `tax[i] = 0`; the line is included in the invoice and in the subtotal normally. `taxRateBp < 0` is rejected. **HSN/SAC remains mandatory on every line, including zero-rated ones.**
**Reason:** zero is a real GST rate, not an absence of one, and HSN classifies the *good*, not its rate — an exempt supply is still a classified supply. Making HSN conditional on rate would put a validation branch on the field most likely to be wrong.
**Explicitly NOT built (GAP):** the payload has no field distinguishing **nil-rated / exempt / zero-rated / non-GST** supplies, which are legally distinct categories that print differently and, for genuinely exempt supplies, may require a *bill of supply* rather than a tax invoice. v2 treats all of them as "rate = 0". Compliance must rule on this before production.

### D-27 · Response contract: `201` synchronous, `200` on replay
**Decision:** success → **`201 Created`** with `{ bill_id, identifier, url }`, where `url` = `${PUBLIC_BILL_BASE_URL}/${identifier}`. A repeated `external_transaction_id` → **`200 OK`** with the *same* body for the existing bill; no new rows, no re-broadcast. Validation failures → `422` with the standard envelope `{error_code, message, field?}` and no write. Unknown `template_id` → falls back to the merchant default and is noted in the response (FSD 5.4), not an error.
**Reason:** two deliberate deviations from the TDS row, both because the TDS assumes an async architecture we do not have.
- **`201`, not `202`:** the TDS returns `202` because rendering is a downstream Kafka consumer, so at ACK time the bill does not yet exist. In our v1/v2 shape, the Order, Bill, OrderItem rows, and Link all commit in a single transaction *before* we respond, and the URL is live the moment the caller reads it. `202 Accepted` would be a false statement about our own system.
- **`200`, not `409`:** the TDS says `409 DUPLICATE`; FSD §5.1, §9, and BR-1 all say "return the existing bill". **The specs conflict.** We follow the FSD, consistent with D-5's reasoning: an offline POS flushing a queue (BR-10) is a legitimate at-least-once replayer, and returning a 4xx to a correct retry invites clients to quarantine the item as a failure.
- **No `short_url`:** in v1 the hosted URL *is* the short link — there is no second, longer URL to shorten. Returning a duplicate field to match a spec shape would be inventing a distinction we do not have.
**Flagged:** the `409` vs `200` contradiction between TDS and FSD needs an owner's ruling before the API contract is published to any external caller (ADR-6 makes it a one-way door).

### D-28 · `Bill.snapshot` whitelist extended for TAX_INVOICE (extends D-17)
**Decision:** in addition to the D-17 field set, `snapshot` may carry, for `TAX_INVOICE` bills only: `invoiceNumber`, `placeOfSupply`, `merchantGstin`, `merchantState`, `merchantAddress`, `subtotalPaise`, `discountPaise`, `taxPaise`, `cgstPaise`, `sgstPaise`, `igstPaise`, `currency`, and an `items[]` array whose members are restricted to exactly `{ lineNo, name, hsn, uom, quantity, unitPricePaise, itemDiscountPaise, billDiscountAllocPaise, taxRateBp, taxableValuePaise, taxPaise, cgstPaise, sgstPaise, igstPaise }`.
**This carries D-17's full Tier-1 weight, and the key-set enforcement test must be extended to cover the nested `items[]` member shape** — a whitelist that only checks the top level is not a whitelist. L-2's Prisma `select` still cannot see inside a JSON column, so P-2 (the writer) remains the only enforcement point.
**Reason:** a tax invoice cannot render without these fields, and every one was checked individually for public-safety: they are all merchant-side or transaction-side facts on a document the customer is legally entitled to receive.
**Named residual risk:** `items[].name` is merchant-supplied free text on an unauthenticated public page. Nothing structurally prevents a merchant from typing customer PII into a line-item description. Not solvable in the core (the field must print); recorded so it is not discovered later. Output-encode it at render regardless (XSS).
**Explicitly excluded:** any customer-identifying block. See GAPS — the B2B recipient-details requirement is unresolved and is *not* built.
---
# Phase 3 — Merchant template UI builder

### D-29 · `layoutSchema` v2: templates migrate once, bill snapshots normalize at read
**Decision:** `Template.layoutSchema` rows are migrated **once, at write** (T-5) into the §2 v2 envelope. `Bill.layoutSnapshot` rows are **never migrated**; a snapshot written in the v1 shape stays v1 forever, and the renderer runs a pure `normalizeToV2()` over it **at read time**. `schemaVersion` absent means version 1.
**Reason:** these look like the same problem and are not. A stored template is live config — one shape is better than two, and the builder must never write back a document whose shape it only half-understands. A bill snapshot is an *issued document*; a migration script that rewrites it is a write to a compliance record, which is precisely what §7 exists to prevent. Read-time normalization is safe because it is deterministic and presentation-identical.
**Test obligation:** a golden test asserting a v1 snapshot renders **byte-identical HTML** before and after the normalizer exists. Without it, "presentation-identical" is a claim, not a property.
**Runner-up:** a permanent read-time shim for templates too. Rejected — two live shapes forever, and every future builder feature has to handle both.

### D-30 · The block manifest and the layout validator are ONE shared module, never duplicated
**Decision:** the manifest (what a block type is) and `validateLayoutSchema()` exist exactly once in the codebase and are imported by both the builder and the write boundary. Duplication-plus-a-drift-test is **rejected**. The physical home is decided by one verified fact, resolved in T-3: if `apps/web` already reaches Postgres directly (as L-2/V-2's server-component read path suggests), manifest + validator + CRUD route handlers colocate in `apps/web` alongside the renderer; if `apps/web` reaches data only through `apps/api`, they are extracted to a workspace package both import.
**Reason:** this answers TEMPLATE_SYSTEM_v2 §11 open question 2. A drift test tells you *after* the two copies disagree; a merchant can have saved an invalid template in between. Colocation is preferred where possible because the manifest's whole justification (§1) is compile-time lockstep with the renderer — putting the manifest in a different app from the renderer weakens the guarantee it exists for.
**Flagged:** the `apps/web` Prisma-reach answer is **unknown at time of writing** and must be confirmed, not assumed. T-3 records the answer here.
**Resolution (T-3)**: apps/web reaches data only through apps/api — verified by inspection: no @prisma/client/PrismaClient import exists anywhere under apps/web, and its only data access is fetch(${API_BASE_URL}/v1/...) calls in app/[identifier]/page.tsx and app/demo/page.tsx. Per D-30's own branching rule, the manifest and (later) validateLayoutSchema() are extracted to a shared workspace package, packages/block-manifest, imported by both apps via workspace:*.

### D-31 · Required-block validation counts only `visible` blocks
**Decision:** §8's rule 2 (`HEADER` and one of `ITEMS`/`CHARGES` must be present) is evaluated over blocks with `visible: true`. A present-but-hidden `HEADER` **fails** validation.
**Reason:** `visible:false` was introduced (§2) so merchants can hide without losing config — which means it is a real path to a bill with no merchant name on it. If presence is checked on the raw array, a merchant hides `HEADER`, validation passes, and the system issues a document with no issuer identified. The rule protects the rendered output, so it must be evaluated against what renders.
**Consequence:** D-10's server-side check must be updated with this phase — it predates `visible` and cannot currently be correct about it.

### D-32 · Fork-on-write mechanics: one transaction, four effects
**Decision:** every save creates a **new** `Template` row (`parentTemplateId` = the edited row, `version` = parent + 1, `isHead = true`), sets the parent's `isHead = false`, and — **if `Merchant.defaultTemplateId` pointed at the parent — repoints it to the new row**. All four inside one transaction. The parent's `layoutSchema` is never written.
**Reason:** §7 already decided fork-on-write; what it did not state is the default-repoint, and that is the step whose omission is silent and total. Without it a merchant edits their template, sees it save successfully, and every subsequent bill renders the old version — a bug with no error message anywhere. `isHead` exists so the builder's list stays finite as versions accumulate; walking `parentTemplateId` to find the leaf would be correct but unindexable.
**Note:** this is a UX/history feature only. Bill immutability rests on `Bill.layoutSnapshot` (§7), not on this, and must continue to hold if fork-on-write is ever removed.

### D-33 · No hard delete — archive, and never the current default
**Decision:** templates are soft-archived (`archivedAt`). Archiving the template currently set as `Merchant.defaultTemplateId` is **refused** until another default is chosen. Clone-from-library is a **deep copy**; a merchant template never references a preset's JSON.
**Reason:** `Bill.templateId` is a required FK, so a hard delete is not merely unwise, it is impossible without either orphaning bills or nulling their provenance. The default-deletion rule is FSD 5.5's stated edge case, adopted as written. Deep copy is §8 rule 7 — a central preset edit must never mutate a merchant's template.

### D-34 · Preview renders client-side, through the production renderer components, inside a same-origin iframe
**Decision:** the FINAL LOOK preview mounts the **same** renderer components the public bill page uses, in the browser, inside a same-origin iframe route that receives the draft document via `postMessage`. **Not** a server round-trip, and **not** a second preview renderer.
**Reason:** the renderer is a pure function of `(layoutSchema, snapshot)` — that is the entire point of the logic-less-blocks design — so it runs identically on either side, and client-side gives per-keystroke feedback with no endpoint that accepts and renders an untrusted draft document. The iframe is the load-bearing part: the bill carries its own skeleton and print stylesheets and a ~380px card width, and rendering it inline inside the builder's chrome lets the builder's CSS cascade into it — the preview would then diverge from production by *styling* even with identical markup. A document boundary makes that structurally impossible and lets the frame be resized to preview mobile and print widths honestly.
**The guarantee is the test, not the architecture (X-1):** render the same `(layoutSchema, fixture)` through the preview path and the production path and assert identical HTML. If a renderer component ever acquires a server-only dependency (Prisma, `import 'server-only'`, an async component), this test is what fails.
**Runner-up:** a server render endpoint returning HTML. Rejected — latency per edit, a new endpoint rendering untrusted input, and injecting the result requires `dangerouslySetInnerHTML`, which §3 spent effort keeping out of this system.

### D-35 · Preview is fed by synthetic fixtures generated from `computeInvoice`, not by a real bill
**Decision:** the preview renders against a code-owned fixture set (`TYPICAL`, `LONG_40_LINES`, `INTER_STATE_IGST`, `ZERO_RATED`, `MINIMAL`), selectable in the builder. Fixture money and tax figures are **generated by running M-2's `computeInvoice`**, never hand-written. Rendering a real historical bill's snapshot is rejected for this phase.
**Reason:** three independent reasons, any one sufficient. (1) A new merchant or a new template has no bill to preview — the real-bill option has no answer for the first-run case. (2) A real bill exercises exactly one path; the builder's job is to show the merchant whether their layout survives 40 line items, mixed slabs, IGST, and a long item name — a two-line intra-state receipt proves nothing. (3) Synthetic fixtures contain no customer data by construction, so the builder surface has **zero PII**, which removes it from the D-17/D-28 whitelist problem entirely rather than adding a new reader to it. Figures are generated rather than typed so the tax ladder in the preview is arithmetically real — a hand-written fixture whose taxes do not sum would make the preview quietly lie about the thing the document exists to state.
**Deferred, not rejected:** "preview with my last bill" is a reasonable later feature; it needs merchant scoping, so it waits for real auth.

### D-36 · `@dnd-kit` is adopted for the BILL tab only — the first UI dependency, justified on a different axis than qrcode-svg
**Decision:** use `@dnd-kit/core` + `@dnd-kit/sortable` for drag interaction on the BILL tab, and nowhere else. **Drag is an enhancement over always-present non-drag controls** (move up / move down / width picker), which must be fully functional with drag disabled.
**Reason:** qrcode-svg was justified as *correctness we should not own* (Reed-Solomon ECC, mask selection — hand-rolling has a high correctness cost and zero product differentiation). Drag-and-drop does not meet that bar: a mis-drop is a visible harmless UI error, not a wrong invoice. It is justified on a different axis — *interaction surface area we should not own*: pointer sensors, collision detection, drop indicators, auto-scroll, and keyboard/a11y announcements are where the bugs actually live, and none of it is differentiating. The decisive point is that **it is a two-way door**: the persisted document holds only `blocks[].order` integers and `width` fractions, so the library touches no stored shape and can be removed in favour of the buttons in an afternoon with **no data migration**. Requiring the non-drag controls to exist anyway is what makes that true, and it independently answers keyboard accessibility and the fact that precise reordering by button beats dragging in a long list.
**Runner-up:** hand-rolled HTML5 drag events. Rejected — no touch support at all, no keyboard story, and the auto-scroll/collision work is the expensive part regardless of who writes it.
**Flagged:** the package's maintenance status and current major version are volatile facts. Verify at install time; do not take them from this document. (`react-beautiful-dnd`'s deprecation is the cautionary precedent here.)

### D-37 · Undo/redo is in scope, in its cheap form only
**Decision:** a bounded in-memory snapshot stack over the draft document (cap 50 states, text edits debounced into one entry, no persistence across reload). No command/inverse-operation model. Cross-session draft recovery and version-history browsing are **out**.
**Reason:** the draft is a single immutable JSON document with stable block ids (§2 names undo/redo as one of the reasons ids exist), so a snapshot stack is a `useReducer` and an array — the expensive general solution buys nothing here. Fork-on-write already provides coarse-grained undo at save granularity; what it cannot provide is within-session undo, which is exactly the gap this fills. Not persisting across reload is deliberate: a restored draft that looks saved but is not is worse than losing it.
**Kill criterion:** it has no data-model dependency and no other task depends on it. If U-1 does not land in one sitting, cut undo/redo and ship the tab — the cost of cutting is zero.

### D-38 · No merchant auth in this phase — single seeded merchant, demo-gated, 404 over 403
**Decision:** the builder and its CRUD surface target the one seeded merchant, behind the same environment gate as `/demo`, returning **404** (never 403) when the gate is off. Merchant scoping is written into every query anyway, even with one merchant.
**Reason:** consistent with v1/v2's precedent, and deliberate rather than deferred-by-neglect: real auth means OIDC, sessions, and per-merchant scoping on every read — the merchant-portal project (handoff item 12), not a task inside this one. 404-over-403 is the demo-endpoint precedent already set: a prober cannot confirm the route exists. Writing the merchant filter now means adding auth later changes where `merchantId` comes from, not what every query looks like.
**PRE-PRODUCTION BLOCKER:** this surface writes the document that renders on a public page. It must not reach any non-local environment before real auth and the FSD §10 auth ruling (see D-19).

### D-39 · No `Template.isDefault` column — `Merchant.defaultTemplateId` stays the single source of truth
**Decision:** reject the `isDefault Boolean` field sketched in TEMPLATE_SYSTEM_v2 §8's Prisma block. The default is expressed only by `Merchant.defaultTemplateId`, which already exists and is already what D-13 reads.
**Reason:** two representations of one fact require an invariant ("exactly one default per merchant per billType") that the database cannot express and code must therefore remember — the exact "add a rule someone has to remember to check" pattern §7 rejected in favour of making invalid states unrepresentable. A single FK column makes more-than-one-default structurally impossible. The cost is real but small: "is this the default?" needs the merchant row, which the builder already loads.
**Consequence:** §8's rule 6 (exactly one default per merchant per `billType`) is **not enforceable as stated** with one `defaultTemplateId` column — v1/v2 have one default per merchant, full stop. Per-billType defaults are a GAP, not built, and were never exercised (D-13 selects the merchant default regardless of type).
