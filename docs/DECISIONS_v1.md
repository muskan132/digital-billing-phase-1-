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

### D-40 · skeleton values are validated the same way block types are (D-10)
**Decision:** an unrecognized `Template.skeleton` must throw, never silently fall back to a default skin. A bad seed, migration, or merchant edit producing an invalid skeleton is a data-integrity bug and must surface immediately, not render successfully with the wrong appearance.

---
# Phase 4 — Merchant self-service portal

### D-41 · The portal principal is `User`, not `Merchant`
**Decision:** the thing that logs in is a `User` row with `type = EXTERNAL` and a non-null `merchantId`. `merchantId` is derived from the user on every request; a `User` with `merchantId = NULL` (an INTERNAL platform user) can complete the IdP flow and is still refused a portal session.
**Reason:** `User.type` and `User.merchantId` already exist and already encode exactly this distinction — the schema anticipated this phase and needs no new tenancy concept. `portals.md` also forbids sharing sessions across portals: an INTERNAL user belongs to the Admin/Support portal, which has a different auth model and a different permission ceiling, so accepting one here would silently create a second portal inside this one.
**Runner-up:** authenticate the `Merchant` directly and skip `User`. Rejected: it makes multi-user-per-merchant a schema change later rather than a UI change, and it throws away the role column `rbac.md` requires guards to honour.

### D-42 · C1 resolution — two principal classes, two answers. Human login is OIDC; no password is ever stored
**Decision:** C1 as recorded in `PENDING_WORK.md` conflates two questions that `rbac.md` keeps separate, and they are answered separately.
- **Calling system (`POST /v1/bills`, D-19):** the organisation's position is already on record — Blueprint §7.1 and ADR-7 specify **OAuth2 client-credentials scoped to `merchant_id`**, with mTLS optional for high-volume partners, and explicitly **reject API keys as the sole mechanism** (no expiry, no scoping, painful rotation). That is the target. It is **not built in this phase** and `MerchantApiKey` + `ApiKeyGuard` remain the local-only stopgap D-19 already scoped them as. C1 stays open as an *implementation* item; its *direction* is no longer open.
- **Human portal user (this phase):** **OIDC Relying Party** (authorization code + PKCE), matching Blueprint §7.1's "OIDC + MFA, SSO with Jio identity where available" for merchant dashboard users. **The portal stores no password, no OTP, and no local credential of any kind.** Locally, a dev IdP container issues the tokens, so the code path that ships is the code path that runs against the real IdP — the change is issuer/client configuration, not code.
**Reason:** the safest default to build against is the one the organisation has already written down. Choosing anything else here would mean either building a credential store we intend to throw away, or contradicting a ratified architecture position on our own authority. Local password auth was the tempting shortcut: it needs no container and no IdP, and it is the worst option, because a password column is the kind of thing that survives "temporary" and lands in production carrying real credentials.
**Runner-up:** email + password with Argon2id, IdP deferred. Rejected on the above; it also puts MFA, reset, and lockout — all explicitly out of scope — on our side of the line instead of the IdP's.
**NEEDS ORGANISATION SIGN-OFF, NOT RESOLVED HERE:** which IdP, which realm/tenant, client registration and secret provisioning, MFA policy for `MERCHANT_ADMIN`, and how a merchant user's `subject` gets provisioned in the first place (the signup gap — out of scope by instruction, but it is the missing half of this flow). Owner: Security + Platform. Until answered, the local dev IdP is the stand-in and **`/portal` must not reach any non-local environment**, exactly as D-38 says of the builder.

### D-43 · A session is an opaque server-side token, not a JWT
**Decision:** on successful login the server generates a high-entropy random token, stores its SHA-256 in `MerchantSession`, and returns the plaintext once in a cookie. Every request hashes the cookie and loads the row. No claims travel in the token; `merchantId` and `role` are read from the database on each request.
**Reason:** revocation. A stateless JWT cannot be killed before expiry without a denylist — which is a database read on every request, i.e. exactly the cost the JWT was meant to avoid, minus the ability to disable a user mid-session. Blueprint §7.1's short-lived JWT is a *BFF-to-service* token, not a browser session, and there is no BFF here; `tech-stack.md` says the same ("short-lived JWTs appear only as BFF session tokens").
**Runner-up:** signed cookie / JWT with a 15-minute expiry and silent refresh. Rejected: buys a saved query, costs instant revocation and forces refresh-token machinery this phase does not need.
**Consequence:** session storage is Postgres, not Redis (Blueprint §5's target). It sits behind a `SessionStore` port so the swap is an adapter.

### D-44 · Cookie-based sessions require CSRF defence, and it is Tier-1
**Decision:** cookie attributes `HttpOnly`, `SameSite=Lax`, `Path=/`, no `Domain`, `Secure` on by configuration everywhere except local HTTP. Every state-changing `/portal` route additionally requires a double-submit CSRF token; a missing or mismatched token is rejected before any handler runs.
**Reason:** choosing a cookie (D-43) is choosing ambient authority — the browser attaches it to cross-site requests too. `SameSite=Lax` alone stops top-level cross-site `POST`s in current browsers but is a browser-version-dependent guarantee, and the write it protects here forks templates that render on a public compliance document. Defence that depends on the user's browser version is not defence.
**Runner-up:** `SameSite=Strict` and no token. Rejected: breaks the IdP redirect return and still leaves the guarantee browser-dependent.

### D-45 · Eligibility is re-checked on every request, not just at login
**Decision:** `SessionGuard` re-loads the `User` on every request and refuses the session if `disabledAt` is set, `merchantId` became null, or `type` is not `EXTERNAL` — in addition to the session's own expiry and revocation.
**Reason:** the alternative is that disabling a merchant user takes effect only at their next login, which for a live session is "never". This is the same principle as `rbac.md`'s "never re-derive identity in a service; always re-check scope" — the check has to be on the hot path or it is not a check.
**Cost, accepted:** one extra join per request. Named so it is not rediscovered as a performance surprise.

### D-46 · `merchantId` comes from a `MerchantContext` resolver; `SEED_MERCHANT_ID` is confined to one file
**Decision:** every merchant-scoped service takes `merchantId` as an argument. A guard populates `MerchantContext { userId, merchantId, role }`: `SessionGuard` from the session, `DemoOnlyGuard` from `SEED_MERCHANT_ID`. No service, repository, or React component reads the constant or the environment. A-4 is the audit task that makes this true and records the full inventory of sites it moved.
**Reason:** D-38 predicted precisely this — "adding auth later changes where `merchantId` comes from, not what every query looks like" — and this is the task that collects on that. One resolver is also the only structure that lets `/demo` and `/portal` share every service without a flag inside the service.
**Verification, not assertion:** the inventory is produced by `grep`, not from memory. The known starting set is `DemoOnlyGuard`-gated controllers, the builder pages, and `templates.service.ts`; seeds and scripts must be swept too. The check that this holds is `grep -rn "SEED_MERCHANT_ID" apps/ packages/ --include=*.ts` returning one non-test file.
**A-4 audit result (2026-08-27), full inventory, not partial:**
- **Moved:** `templates.service.ts` — deleted its own local `SEED_MERCHANT_ID` const and all 8 usages across `list`/`findOne`/`save`/`clone`/`setDefault`/`archive`; every method now takes `merchantId: string` as an argument. `templates.controller.ts` now resolves it via `@CurrentMerchantContext()` and passes it through — previously called the service with **zero** arguments, relying on the service's internal hardcoding.
- **Confined here:** `demo-only.guard.ts` — the sole remaining reader. Now attaches `request.merchantContext = { userId, merchantId, role }` (real seeded `User` id/role, not fabricated — the approved design point) in addition to its existing `NODE_ENV` check.
- **Renamed, not removed:** `verify-x2-immutability-regression.ts`'s own local `SEED_MERCHANT_ID` → `TEST_MERCHANT_ID` (same literal value) — a verification script, not a service, but the identifier still needed to stop matching the audit grep; its `clone()`/`save()` calls updated for the new signatures.
- **Untouched, out of scope, with reason:** `seed.ts` (already used a differently-named local const — the value's origin, not a read of it); `ApiKeyGuard`/`BillsService`/`BillsController` (a separate, already-correct `merchantId`-as-argument mechanism for the direct-API calling-system path, D-19/D-42 — no `MerchantContext` involved); `demo.service.ts`'s `DEMO_MERCHANT_JIOPAY_MID` (a different value — JioPay's own mid for simulating an inbound webhook payload, not our internal `Merchant.id`); `apps/api/sample-bill.json`/`broken-bill.json` (ad-hoc curl-test payloads, not code); `apps/web` (zero hits — the builder never reaches Prisma directly).
- **Verified, not merely typechecked:** full `pnpm --filter @digital-billing/api verify:x2` re-run against the live DB after the refactor — real `clone()`/`save()` calls through the new parameterized signatures, byte-identical outcome to before.

### D-47 · Cross-tenant access returns 404, never 403
**Decision:** a `/portal` request for a `billId`, `templateId`, or `identifier` belonging to another merchant returns `404` with a body that does not distinguish "not yours" from "does not exist".
**Reason:** the demo-endpoint precedent, applied to resources instead of routes: `403` confirms the id is real and turns any id field into an existence oracle. `cuid`s are not enumerable, but the resource id often arrives from somewhere else (a link, an email, a leaked log), and `403` is what makes it useful.

### D-48 · The merchant-visible contact projection is a NEW PII boundary, not a relaxation of D-17/D-28
**Decision:** the portal may show a merchant their own customers' contact details, in a projection that is defined, whitelisted, and enforced independently of the `Bill.snapshot` whitelist:
- **List (`GET /portal/bills`): masked only** — e.g. `98****3210`, `a***@example.com`.
- **Detail (`GET /portal/bills/:id`): full value**, and only these fields: `customerMobile_pii`, `customerEmail_pii`, plus `Broadcast.{channel, status, attempts, sentAt}` and the **masked** `Broadcast.recipient`.
- Enforced in the portal DTO **at the writer** (the serializer), with a key-set test, per the boundary-enforcement principle — not as a comment at the reader.
- Never logged, never in an error body, never in an event.
**Reason:** this is a different principal reading different data for a different reason, not the same rule loosened. D-17/D-28 govern `Bill.snapshot`, which is read by an **anonymous** visitor holding only a URL; nothing about the merchant's own access changes that, and `Bill.snapshot` gains **zero** fields from this decision — it stays PII-free forever. The merchant is the party that captured the contact detail in the first place and is the data controller for it; withholding it from them protects nobody. Masking the list anyway is because a list is the shape that gets screenshotted, shoulder-surfed, and eventually exported, and a merchant almost never needs 50 phone numbers at once — they need one.
**Named residual risk:** there is no audit trail on these reads. `security.md` requires PII *exports* to be audited; single-record reads by the owning merchant are not exports, which is why export is out of scope for this phase (see GAPS). If export is ever built, it needs an audit table first, not after.
**Explicitly unchanged:** the public bill page, the renderer, `Bill.snapshot`, `Bill.layoutSnapshot`, and the L-2 whitelist. A UAT step asserts the public page for the same bill still contains no contact data.

### D-49 · `/demo` coexists indefinitely; convergence by rule, not by deletion
**Decision:** `/demo/*` and `DemoOnlyGuard` stay exactly as they are. `/portal` is additive. The standing rule from this phase forward: **new merchant-facing functionality is built at `/portal` first**; a demo route may alias it, but no feature is built demo-only again. `/demo` is deleted only when it holds nothing the portal does not, and that deletion is its own task in a later phase.
**Reason:** the demo panel is real, working local tooling with no login step, and deleting it would slow down every subsequent phase's manual verification for a tidiness gain. Sharing one service layer through D-46's resolver means the two routes cannot drift in behaviour — which is the actual risk of keeping both, and it is structurally closed rather than promised.
**Runner-up:** fold `/demo` into `/portal` now with an auto-login shortcut. Rejected: an auto-login bypass is a real authentication bypass living in the same code as real authentication — a far worse object to own than a separate gated route.

### D-50 · Roles are enforced at the guard now; user management is deferred
**Decision:** `SessionGuard` checks `User.role` against the `rbac.md` role table for every `/portal` route (builder writes require `MERCHANT_ADMIN`; history is readable by `MERCHANT_ADMIN` and `STORE_STAFF`). The schema already supports N users per merchant and nothing in this phase prevents that; what is deferred is the **UI and API to create, invite, disable, or re-role a user**, and any store-scoped assignment.
**Reason:** writing the gate now costs one line per route and means adding a second user later is a data change, not a security review. Deferring the gate would mean every `/portal` route is implicitly `MERCHANT_ADMIN`, and un-picking that after the fact is the expensive direction.
**Named gap:** only one `MERCHANT_ADMIN` is seeded, so the `STORE_STAFF` paths are **written but not exercised**. They must be tested with a real second seeded user before any non-local deployment; a role gate nobody has ever hit is a claim, not a control.

### D-51 · Session rows are the one carve-out from the no-hard-delete rule
**Decision:** expired `MerchantSession` rows may be hard-deleted by a reaper job. Every other entity in this system remains soft-archive-only (D-33). Revocation is still a state change (`revokedAt`), never a delete — only *expiry* permits removal, and only after `expiresAt` has passed.
**Reason:** the no-hard-delete rule exists because business documents must stay auditable and because `Bill.templateId` makes deletion structurally impossible anyway. A session is neither: nothing references it by FK, it carries no business fact, and it accumulates one row per login forever. Writing this down as a decision rather than letting a cleanup script quietly appear is the point — an undocumented exception to a project-wide invariant is how the invariant stops meaning anything.
**Consequence:** "who logged in when" is **not** recoverable from this table after reaping. `User.lastLoginAt` is the only login trace that survives, and it is a single overwritten timestamp, not a history. If a login audit trail is ever required, it is a separate append-only table — not a reason to stop reaping sessions.
**Reaper is not in the v4 roadmap.** Row growth on a single-merchant local database is not a problem worth a scheduled job yet; this decision authorises the reaper, it does not schedule it.

### D-52 · Local dev IdP is `node-oidc-provider`, run as a workspace app — no new container image
**Decision:** the local OpenID Provider is **`node-oidc-provider`** (the `panva` library), run as a small app in the existing pnpm workspace, with the portal's RP side using its sibling **`openid-client`**. Its built-in dev interaction views supply the login screen. No new Docker image; `docker compose` gains no service, only the existing Node runtime gains one more process under `dev-up.ps1`.
**Reason (one line):** it is an OpenID-certified implementation in the stack the repo already runs, so the RP code exercises real spec behaviour — JWKS rotation, `nonce`, PKCE, discovery — without adding a JVM container to a dev loop that already fights orphaned Node processes on ports 3000/4000.
**Runner-up:** **Keycloak**. It is the closest thing to the enterprise IdP this will eventually point at (realms, MFA policy, admin console), and that realism is genuinely worth something for D-42's unresolved MFA question. Rejected for now on weight: a JVM container with a multi-second cold start, on every local run, to serve a login form. If Security names Keycloak as the production IdP, revisit — the RP side does not change, which is the whole point of the port in A-1.
**Also rejected:** `oauth2-mock-server` and similar token-minting mocks — they skip the authorization-code interaction entirely, so the flow we test is not the flow we ship, which defeats D-42's stated reason for choosing OIDC in the first place.
**VOLATILE FACT — verify at install, do not take from this document (D-36 precedent):** the current major version, its maintenance status, its Node version floor, and whether `devInteractions` is still enabled by default. My reading of the last two is **likely, not verified** — if `devInteractions` has been removed or defaults off, a minimal interaction route must be written, which is a small addition to A-1's scope, not a reason to change the choice.
**Blast radius — CORRECTED (this entry originally said "this dependency is dev-only", which was wrong and would have misled the A-1 implementer):** the two packages have **opposite** lifetimes and must never be described together. `openid-client` is the RP side — it **ships**, and is a real production `dependency` of `apps/api`. Only `node-oidc-provider` is dev-only. Neither touches a persisted shape, a money path, or a PII column. In any non-local environment the `IdentityProvider` port points at the real IdP and `node-oidc-provider` is not loaded. The enforcement mechanism is D-53.

### D-53 · The dev IdP is isolated by workspace topology, not by a dependency label
**Decision:** `node-oidc-provider` is a `dependency` of a **separate workspace app, `apps/dev-idp`**, and appears in **no other `package.json` in the repo**. `apps/api` never lists it, never imports it, and cannot resolve it. `openid-client` (the RP side) is a normal production `dependency` of `apps/api` and **ships** — it is not part of this isolation and must not be moved.

```jsonc
// apps/api/package.json          — the RP. SHIPS.
{ "dependencies": { "openid-client": "^6.x" } }        // node-oidc-provider absent, in BOTH blocks

// apps/dev-idp/package.json      — the OP. Never built for production.
{ "private": true,
  "dependencies": { "node-oidc-provider": "^9.11.3" }, // pinned range verified at install (D-36)
  "scripts": { "dev": "tsx src/main.ts" } }            // no "build" script — nothing to ship

// pnpm-workspace.yaml            — already lists apps/*; no change needed
```

**Reason:** pnpm's non-hoisted `node_modules` makes this structural rather than procedural. A package absent from `apps/api/package.json` is **not resolvable** from `apps/api` source — `import "node-oidc-provider"` fails at typecheck and at build, not at runtime in production. That is "make the invalid state unrepresentable" (the §7 principle) applied to a dependency graph.
**Runner-up:** put `node-oidc-provider` in `apps/api`'s `devDependencies`. **Rejected** — and this is the trap worth naming, because it is the obvious answer. A `devDependency` is fully resolvable and importable from `apps/api` source; the label only governs what `pnpm install --prod` fetches, not what the code may reference. A bundler following a real import will happily inline it, and the failure appears in a production bundle, not in CI. `devDependencies` is a rule someone has to remember; a missing workspace edge is a compiler error.
**Belt-and-braces, both cheap:** `apps/dev-idp` refuses to boot when `NODE_ENV=production`; CI asserts the isolation rather than trusting it (see A-1's verify step).
**Standing rule:** any future dev-only service (a mock PG, a mock SMS provider) follows this same topology. Do not start a `devDependencies` precedent here.

### D-54 · What the dev IdP proves, and what it does not — `devInteractions` accepts any credentials
**Decision:** `node-oidc-provider`'s `devInteractions` (verified: defaults to `true` in 9.11.3) accepts **any username and any password**. There is no credential store behind it locally. This is recorded as an explicit scope boundary in A-1's plan, in the `apps/dev-idp` README, and in a comment at the top of the RP adapter — not left for a reader to infer.

| Exercised locally, genuinely | **Not** exercised locally, at all |
|---|---|
| RP protocol handling: discovery, PKCE, `state`, `nonce`, JWKS verification, `id_token` signature and claim validation, failure paths | **Whether the person logging in is who they claim to be.** No password is checked, no MFA is performed, no lockout, no rate limit |
| **Our authorization**: D-41's eligibility gate, D-45's per-request re-check, D-50's role gate, D-47's cross-tenant 404 | Anything an IdP would enforce: credential strength, account lockout, session policy at the IdP, MFA for `MERCHANT_ADMIN` |

**Reason:** this is D-42's own logic followed to its conclusion — the reason for choosing OIDC was to put credential verification **on the IdP's side of the line**, permanently. A local setup that verified credentials would mean we had built a credential store, which is exactly what D-42 refuses. So the gap is not a shortcoming of the dev setup; it is the shape of the decision, visible. The danger is only that a future reader sees a working login screen and concludes authentication is tested.
**Consequence, stated plainly:** a green A-1 and A-2 mean **"the RP handles the protocol correctly and our authorization gates work"**. They do **not** mean authentication works. Authentication cannot be tested in this repo at all, by design, and its correctness is entirely inherited from whichever IdP D-42's open sign-off eventually names — which is one more reason that sign-off is a pre-production blocker and not a formality.

### D-55 · openid-client does not verify id_token signatures by default on the direct token-endpoint exchange
**Decision:** `enableNonRepudiationChecks` is called during OIDC client discovery in `oidc-identity-provider.adapter.ts`, forcing explicit cryptographic signature verification of every `id_token`, regardless of transport.
**Reason:** per OIDC Core §3.1.3.7, TLS on the direct authorization-code token-endpoint channel is spec-permitted to substitute for signature verification — `openid-client`/`oauth4webapi` follows this by default. Locally, `apps/dev-idp` runs over plain HTTP (`allowInsecureRequests`), so that substitution never actually held, meaning a corrupted `id_token` claim was silently accepted in initial testing. This was caught only because A-1's verify step required demonstrating a tampered-signature rejection, not merely asserting one. Roadmap A-1 explicitly requires "JWKS-verified `id_token`" unconditionally — this decision makes that literal, not transport-dependent.
**Consequence:** had this shipped unnoticed, ANY environment relying on TLS alone (not just this local HTTP case) would still be exposed if TLS termination happens somewhere the token doesn't traverse fully encrypted (a reverse proxy, a misconfigured load balancer) — explicit signature verification is strictly safer regardless of transport.

### D-56 · MerchantSession TTL is 24 hours, absolute, no sliding renewal
**Decision:** `MerchantSession.expiresAt` is set to exactly 24 hours from issuance at login. No sliding/rolling renewal on activity — a session that is still being actively used at hour 24 expires anyway, same as an idle one.
**Reason:** D-43 already named the shape ("absolute expiry, no sliding renewal") but never the number, leaving a future reader to infer it from code rather than read it here. 24 hours is chosen as a plain, unremarkable default for a merchant-portal session with no stated business requirement pushing it shorter or longer; there is no per-role or per-risk variation in v4 (D-50's `STORE_STAFF` path gets the same TTL as `MERCHANT_ADMIN`).
**Consequence:** a merchant logged in at 9am is logged out at 9am the next day regardless of activity in between, and must go through `/auth/login` again — no silent re-issuance. Revisit if UAT feedback finds 24 hours too short/long; changing the number is a one-line change, not a design change.

### D-57 · CSRF: synchronizer token, HMAC-derived from the session, enforced globally at APP_GUARD — no CSRF cookie exists
**Decision:** every state-changing (`POST`/`PUT`/`PATCH`/`DELETE`) `/portal` route requires an `X-CSRF-Token` header equal to `HMAC-SHA256(CSRF_SECRET, sessionToken)`, where `sessionToken` is the same raw value already carried in the `session` cookie. `CsrfGuard` recomputes this HMAC itself and compares — **no second cookie is ever set for CSRF at all.** Enforced by registering `CsrfGuard` as a global `APP_GUARD`, matched internally by route prefix (`/portal`) and HTTP method (mutating only) — a new `/portal` route inherits protection with no per-controller decorator to remember.
**Client obtains the token via `GET /portal/csrf-token`** (itself behind `SessionGuard`, requiring an already-valid session): called once after login, cached client-side for the session's lifetime, and attached as `X-CSRF-Token` on every subsequent mutating request. Never delivered any other way.
**Reason:** D-43 already rejected stateless (JWT) sessions in favour of Postgres-backed server state specifically so revocation and server-side truth are possible. Double-submit's justification (per OWASP's own CSRF cheat sheet) is specifically for architectures that *lack* that server-side state — this project has it, so a synchronizer-style token is strictly simpler and closes an exposure double-submit accepts by design: a double-submit cookie must be `HttpOnly=false` (client JS has to read it to echo it back), meaning any XSS on `/portal` could read the CSRF token itself. A synchronizer token needs no such cookie — it's obtained once via an authenticated JSON response and held in memory/storage the page's own JS controls, never automatically attached by the browser the way a cookie is, and never persisted as a second HttpOnly-less credential sitting alongside the session cookie.
**Runner-up:** double-submit cookie (`HttpOnly=false`, echoed via header, compared to the cookie value). Rejected per the reason above — this project's server-side session store makes the double-submit's core justification not apply, and its `HttpOnly=false` requirement is a real, avoidable exposure.
**Cookie attributes:** none — there is no CSRF cookie. The existing `session` and `oidc_flow` cookies (D-44) are unchanged by this decision.
**`SameSite` note (checked, not assumed):** irrelevant to this design since no CSRF cookie exists, but confirmed while evaluating the alternative: the CSRF concern never touches the `/auth/login` → IdP → `/auth/callback` redirect chain either way — that chain only ever reads/writes the `session` and `oidc_flow` cookies, both already `SameSite=Lax` (D-44), unaffected by this decision.
**Exemptions, explicit:** `GET /auth/login`, `GET /auth/callback` (no session exists yet at this point in the flow), every `GET` under `/portal` (exempt by HTTP method, not by an enumerated route list — this is what makes a future `GET`-only read safe without a code change). Any non-`/portal` route (`/v1/*`, `/demo/*`) is untouched — `CsrfGuard`'s own path-prefix check is a no-op there, a different trust model entirely (D-19/D-46).
**Failure mode:** both a missing token and a mismatched token return the same `403` with `{ error_code: 'CSRF_TOKEN_INVALID' }` — deliberately not distinguished, so the response can't be used to tell "no token sent" apart from "wrong guess." Comparison is timing-safe (`crypto.timingSafeEqual`), matching `ApiKeyGuard`'s existing precedent.
**New env var:** `CSRF_SECRET` (`apps/api/.env`/`.env.example`) — a dedicated secret, not reused from `SECRET_KEY` (which authenticates JioPay webhook HMACs, D-2/D-3's concern) — mixing two independent secrets across unrelated trust boundaries means compromising one leaks the other's capability. `.env.example` documents a placeholder value only.
**Verification:** `csrf.guard.spec.ts` (missing/mismatched token → `403 CSRF_TOKEN_INVALID`; correctly-derived token → passes; `GET` → always exempt; non-`/portal` path → no-op) plus a structural test: a throwaway, undecorated `POST /portal/__test_probe` route on a real bootstrapped Nest app, hit over real HTTP with no token, asserting `403` — proof the global guard protects a route nobody remembered to decorate, not merely that the guard's own logic is correct in isolation.
### D-58 · Keyset pagination is hand-built (manual OR tie-break), not Prisma's native `cursor`; a new composite index backs it; contact masking for the list DTO is its own function, distinct from log masking

**Decision:** `GET /portal/bills` sorts `createdAt DESC, id DESC` and paginates via an opaque
base64 cursor encoding the last row's own `{createdAt, id}`. The next page's WHERE is built
by hand — `createdAt < cursor.createdAt OR (createdAt = cursor.createdAt AND id < cursor.id)`
— composed through Prisma's query builder (`OR`/`AND`), not raw SQL. A new index,
`Bill(merchantId, createdAt, id)`, backs it. `PORTAL_BILLS_DEFAULT_LIMIT = 20`,
`PORTAL_BILLS_MAX_LIMIT = 100` (requests above 100 are rejected with 400, not silently
clamped). List-DTO contact masking is a new pair of functions,
`maskMobilePortal()`/`maskEmailPortal()` (`apps/api/src/common/portal-contact-mask.util.ts`),
matching D-48's literal examples exactly (`98****3210`, `a***@example.com`) and returning
`null` — not a placeholder string — when contact is absent.

**Reason (pagination mechanism):** Prisma's built-in `cursor:` option is designed around a
single unique field; it has no way to express the cross-field inequality a real keyset
tie-break needs when the primary sort column (`createdAt`) isn't itself unique. The
alternative — sorting by `id` alone, or accepting occasional skip/repeat on a `createdAt` tie
— was rejected because two bills can share a millisecond-resolution timestamp under load, and
"never skip or repeat a row across a live page fetch" is this route's actual contract, not
"never skip or repeat a row unless two bills happen to share a timestamp."

**Reason (masking function):** `mask.util.ts`'s existing `maskMobile()` (used only in log
lines) keeps the last 2 digits, not the last 4 — a different, more aggressive format than
D-48's literal example. Reusing it for the portal DTO would silently ship a masking behavior
the doc doesn't actually describe. Rather than resolve that by editing either the doc or the
log-masking behavior other code already depends on, this is a new, narrowly-scoped function
whose only job is matching D-48's contract exactly; `mask.util.ts` is untouched.

**Runner-up (pagination):** offset/`skip`-based pagination. Rejected outright — `SCOPE_v4.md`
§4 requires keyset explicitly, and offset pagination is exactly what silently skips or repeats
rows when a new bill is inserted between two page fetches.

**Verification:** `portal-bills.service.spec.ts` (mocked — scoping, filter folding, DTO
key-set, BigInt→string, cursor→OR translation, validation) plus
`portal-bills.service.integration.spec.ts` (real Postgres — cross-merchant isolation
cross-checked against `prisma.bill.count()`, source-filter partitioning, and a real bill
inserted between two sequential page fetches proven to land exactly once on the correct page).
### D-59 · SessionGuard's role check read only method-level @Roles(); class-level was silently ignored

**Decision:** SessionGuard.canActivate now resolves required roles via
`reflector.getAllAndOverride(ROLES_KEY, [context.getHandler(), context.getClass()])` —
method-level metadata wins when present, class-level is the fallback. Previously it called
`reflector.get(ROLES_KEY, context.getHandler())`, which only ever sees metadata attached
directly to the route handler.

**The bug:** `PortalBillsController` (H-1) and `PortalTemplatesController` (W-2) both declared
`@Roles(MERCHANT_ADMIN, STORE_STAFF)` at the CLASS level. `context.getHandler()` never sees
class-level metadata, so the role check silently evaluated to "no roles required" on every
route in both controllers — any authenticated user, any role, passed regardless of the
decorator. This was not a tenancy leak (merchantId scoping is a separate, correct mechanism)
but the role gate itself did nothing since A-3 shipped it.

**Why it wasn't caught earlier:** `session.guard.spec.ts`'s existing role tests mocked
`reflector.get()` directly and asserted the guard's own if/throw logic given a role list —
they never exercised real NestJS metadata resolution against an actually-decorated class, so
a broken class-vs-method read was invisible to them. It also never surfaced behaviorally
because H-1 and W-2 only ever needed one uniform role set (MERCHANT_ADMIN + STORE_STAFF) and
only MERCHANT_ADMIN is seeded — a no-op gate and a working one produce identical results until
a route needs a NARROWER role set than its siblings, which is exactly what W-3's builder
writes (MERCHANT_ADMIN only, vs. reads' MERCHANT_ADMIN + STORE_STAFF) introduced for the first
time.

**Consequence:** H-1's and W-2's role gates begin actually enforcing as a direct effect of this
fix — no behavior change was intended or needed there (both already declared the same
MERCHANT_ADMIN + STORE_STAFF set at the class level, which is still correct), but it is worth
naming that their read routes go from unenforced to enforced the moment this ships. Confirmed
via a real-Nest-app structural test (session.guard.spec.ts) that both roles still pass those
routes unchanged.

**Verification:** two real-HTTP structural tests (real `Reflector`, no mocking of the
resolution mechanism itself) — one in `session.guard.spec.ts` proving class-level-only routes
accept both roles and a method-level override wins over the class default; one in
`portal-templates.controller.spec.ts` proving the concrete case this bug protects:
STORE_STAFF → 403 on every builder write route, MERCHANT_ADMIN → 200/201 on all of them — the
exact line A-3's roadmap row named and that had never actually been true until now.

# Phase 5 — Template lifecycle, delivery visibility, export

### D-60 · Two default templates per merchant, one per `billType` — D-39's recorded gap, paid off

**Decision:** `Merchant.defaultTemplateId` is **renamed** to `defaultReceiptTemplateId`, and `defaultTaxInvoiceTemplateId` is added alongside it. The PG callback path reads the receipt pointer; `POST /v1/bills` reads the tax-invoice pointer. Both are nullable FKs to `Template` with distinct relation names.

**Reason:** D-39's own consequence section already recorded this: "§8's rule 6 (exactly one default per merchant per `billType`) is **not enforceable as stated** with one `defaultTemplateId` column — per-billType defaults are a GAP, not built." That gap is now blocking. The single pointer today aims at "Minimalist Receipt", a `RECEIPT` template, on a system whose direct API only ever issues `TAX_INVOICE` bills — so the pointer was structurally unusable on that path, and `resolveTaxInvoiceTemplate` invented a positional substitute (oldest own tax-invoice template by `createdAt`, then oldest shared). A merchant could not choose the template their invoices used, because there was no field to hold the choice.

**This is not a reversal of D-39.** D-39 rejected an `isDefault Boolean` because it duplicated a fact `Merchant.defaultTemplateId` already held — two representations of one fact, requiring an invariant the database cannot express. Two FK columns hold **two different facts**: which template is the default for receipts, and which for tax invoices. Each remains singly represented, and more-than-one-default-per-type stays structurally impossible.

**Runner-up:** a `MerchantDefaultTemplate(merchantId, billType, templateId)` table with `@@unique([merchantId, billType])`. It is the more correct shape in the abstract — the database enforces one-default-per-type for any future bill type, which is D-39's own "make invalid states unrepresentable" argument taken further. **Rejected on blast radius, not on merit:** there are exactly two bill types, the enum has been stable across four phases, and migrating the pointer out of `Merchant` would touch the PG callback path's `include: { defaultTemplate: true }` — the write path carrying the most hard-won correctness in the system. If a third bill type ever appears, promoting two columns to that table is a contained migration.

**Rename, not drop-and-add:** the existing value must survive the migration. A drop-and-add would silently null every merchant's default, and the PG callback path treats a missing default as a config error that commits an Order with no Bill (D-14a) — a data-loss failure that looks like a handled edge case.

---

### D-61 · Direct-API template resolution: scoped lookup, default fallback stated in the response, `422` on bill-type mismatch

**Decision:** `POST /v1/bills` resolves `template_id` as follows. The lookup stays scoped to `{ id, OR: [{ merchantId }, { merchantId: null }] }` with `merchantId` guard-resolved. An **unknown or not-yours** id falls back to the merchant's `defaultTaxInvoiceTemplateId`, and the response states the fallback and its reason explicitly, alongside the existing `template_id_used`. A **real, visible template of the wrong `billType`** is `422 TEMPLATE_BILL_TYPE_MISMATCH` with no write of any kind. The positional fallback chain — oldest own tax-invoice template by `createdAt`, then oldest shared — is removed entirely.

**Supersedes D-13** ("no per-order override in v1"), which was explicitly v1-scoped. The override is now a supported part of the contract.

**Reason:** the two failure cases are genuinely different and were being treated identically. An unknown id is usually a stale or mistyped reference and the merchant still wants their bill — FSD 5.4 and D-27 already say fall back, and the only change is that the fallback stops being invisible. A wrong-bill-type id is a *correct* id used incorrectly: the merchant is holding a real template and believes it is being applied. Silently substituting a different one there means every bill renders from a template the merchant did not choose, with a `201` and a working URL to confirm the mistake. That is the same class of silent-success failure D-32's default-repoint exists to prevent.

The positional chain goes because it answers a question nobody asked: "which of your tax-invoice templates was created first" has no product meaning, and it made the merchant's actual choice (D-60's pointer) unreachable.

**Breaking change, taken deliberately and now:** a caller sending a wrong-bill-type `template_id` receives `201` today and `422` after this change — a request that succeeded starts failing, and a POS that doesn't handle `4xx` may end a sale with no bill. This is free today: the contract is local, behind a demo API key, with one seeded merchant and no external integrator. D-27 already flagged publishing this API as a one-way door (ADR-6); after a real POS is integrated the same change needs a version, a deprecation window and a migration conversation. Adding the fallback-reason **field** breaks nobody and is purely additive.

**Unchanged:** the JioPay callback path has no override and never will — the webhook payload carries no template field, and `jiopay-callback.dto.ts` has zero occurrences of one. It reads `defaultReceiptTemplateId`, full stop.

---

### D-62 · Save renames in place; Save As is always a clean break

**Decision:** two distinct write paths, with distinct meanings.

- **Save** is D-32's fork, unchanged in all four effects, plus an optional `name` that renames within the lineage. The merchant sees **one** list entry, because `list()` filters on `isHead` — a fork inside a lineage replaces the entry rather than adding one.
- **Save As** creates a **new lineage**: `parentTemplateId: null`, `version: 1`, `isHead: true`, `merchantId` = the session merchant. It performs **exactly one** of D-32's four effects — writing the new row. It does **not** flip the source's `isHead` and does **not** repoint either default. It persists the **edited** document from the request body, never the source's stored one. It works identically from a starter and from the merchant's own template, and records **no link** back to the source.

**Reason:** "in place" is a statement about the merchant's list, not about the row. Fork-on-write already produces exactly the in-place experience for Save, so no part of D-32 needs relaxing to give the merchant a Save button that behaves the way they expect. Save As diverges precisely because the source must survive: flipping the source's `isHead` would remove it from the list, which is the opposite of what Save As means, and repointing a default to a copy the merchant did not designate is a silent change to what every future bill renders.

**No provenance link, decided explicitly:** `parentTemplateId` already means one specific thing — "the version I forked from *within this lineage*" — and `isHead` plus that column are what make lineage walking tractable. Overloading it with "the template I copied from" would make a lineage walk ambiguous and would let a merchant-owned row trace its history back into a shared starter, which D-33's deep-copy rule exists to prevent. Recording provenance would need its own column, and nothing in this phase or Phase 6 reads it.

**Consequence:** `clone()`'s `CANNOT_CLONE_MERCHANT_TEMPLATE` refusal is removed and `clone()` folds into the single Save As path. `save()`'s `CANNOT_FORK_LIBRARY_PRESET` refusal **stays** — it is what makes "editing a starter requires Save As" structural rather than a UI convention.

---

### D-63 · Template names are unique per merchant among live head rows, enforced by a partial index

**Decision:** a partial unique index — `UNIQUE ("merchantId", "name") WHERE "isHead" = true` — plus a server-side allocator that appends `(1)`, `(2)`, `(n)` to a taken name. The allocator applies on Save As, on rename via Save, and on restore. A `P2002` from a concurrent allocation is caught and retried with the next suffix, bounded.

**Reason, and the trap it avoids:** a plain `@@unique([merchantId, name])` **cannot work here and would break every save immediately**. Every save forks: it creates a new row carrying the parent's name while the parent still exists. Naive name-uniqueness and fork-on-write are structurally incompatible, and the incompatibility only shows up at the first save, not at migration time.

The partial index expresses the rule the merchant actually means: no two *live, current* templates in my list share a name. Superseded versions keep their names harmlessly because they are no longer head.

**Why the existing transaction already satisfies it, with no change:** `save()` flips the parent's `isHead` to `false` **before** creating the forked row, inside the same transaction. At the moment the new row is inserted, the parent has already left the index's scope. The ordering the index requires is the ordering that already exists.

**Starters are outside the constraint.** Postgres ignores NULLs in unique indexes, so the six `merchantId: null` starter rows are unaffected and may share names with any merchant's templates.

**Retry, not count-then-insert:** computing the next free suffix and inserting is not atomic, and this project already carries one recorded `P2002` race on the callback path. Handling the conflict rather than assuming it away avoids adding a second one.

**Prisma cannot express a partial unique index declaratively** — S-11's migration is hand-written SQL with the reason in a comment.

**Named precondition:** the local database holds 28 rows accumulated from repeated `verify:x2`/`verify:x3` runs. Duplicate head names among them will make index creation **fail**. Cleaning them, and fixing the verify scripts to remove the lineages they create, is part of S-11 rather than housekeeping.

---

### D-64 · Hard delete exists, as a structurally-enforced carve-out from D-33

**Decision:** a template lineage may be **hard-deleted** — every version row in it — exactly when **no `Bill` references any version in that lineage**. Otherwise the request is refused with `422 TEMPLATE_HAS_ISSUED_BILLS`, naming archive as the alternative. Neither current default may be deleted. Deleting an archived template is permitted. This is the **second** written exception to D-33's project-wide no-hard-delete rule; D-51's session-reaper carve-out is the first.

**Reason:** D-33 did not reject hard deletion as a preference. It rejected it as impossible — "`Bill.templateId` is a required FK, so a hard delete is not merely unwise, it is impossible without either orphaning bills or nulling their provenance." That reasoning is exactly conditional: where no bill references the lineage, the impossibility does not apply, and Postgres enforces the condition itself rather than the application promising it. That is the same standard D-51 held itself to, and the reason it is written down as a decision rather than allowed to appear as a helpful method: an undocumented exception to a project-wide invariant is how the invariant stops meaning anything.

**Whole lineage, not the head:** deleting a template while four superseded versions linger is not a delete, and the bill check must walk **every** row in the lineage. A bill may reference an older version while a newer one is head — a head-only existence check would wrongly permit that delete and orphan a real bill's FK. This is the single most likely implementation error in F-4 and is called out in its verify step.

**Refusal, not silent archive:** a delete button that sometimes archives without saying so trains the merchant to distrust every other control on the page. The cost is accepted: a merchant will occasionally hit a wall they did not expect, and the error message is what makes that survivable.

**Consequence:** a deleted template is unrecoverable and its name is freed immediately. Archive remains the reversible path and keeps its name reserved (D-65).

---

### D-65 · Archive is a place with a way back; restore auto-suffixes

**Decision:** archived templates leave the main list and appear in a separate archived view. `restore` clears `archivedAt`. Archived rows **keep** `isHead`, which is what keeps their names reserved against the D-63 index. A restore whose name has been taken in the meantime is auto-suffixed to `(n)` by the same allocator, rather than refused.

**Reason:** the reservation falls out of the index for free — no additional logic — because archive touches `archivedAt` and never `isHead`. It also matches the merchant's mental model: an archived template still exists and is still theirs, so its name is still spoken for; a deleted one is gone, so its name is not.

Auto-suffixing on restore rather than refusing is chosen because refusal puts the merchant in a dead end — they must rename a template they can no longer see in order to restore it. Suffixing always succeeds and leaves both rows live and distinguishable.

**Consequence:** archiving "Retail Bill" and creating a new one yields "Retail Bill (1)". This will occasionally look surprising to a merchant who thinks of archive as removal. It is the intended trade for keeping archive fully reversible, and it is exactly the case delete exists to serve instead.

---

### D-66 · Creating from scratch requires name, `billType` and `skeleton`; `skeleton` is immutable thereafter

**Decision:** `POST /portal/templates` takes `{ name, billType, skeleton }` and creates a `version: 1`, `parentTemplateId: null`, `isHead: true` row owned by the session merchant, starting from a **minimal document that already satisfies validation** — a visible `HEADER` and a visible `ITEMS`. `skeleton` is chosen once, here, and no write path accepts a change to it afterwards.

**Reason:** "from scratch" cannot mean an empty canvas, for two independent reasons already decided. D-31 evaluates §8's required-block rule over **visible** blocks, so a blank document fails validation — a merchant could create a template and then never be able to save it. And `skeleton` is a required enum whose unrecognised values must throw rather than fall back (D-40); it is the card chrome — width, print styling, thermal strip versus full-width invoice — which the block editor cannot produce and which has no sensible default across bill types.

**Immutability is the existing behaviour, made explicit:** `save()` already reconstructs `skeleton` from the parent and never trusts the client. Recording it as a decision means a future "let them change the skin" request is evaluated as a change to a written rule rather than as a small addition — it would let the render chrome of a live template change under a merchant between two bills.

**Named gap:** there is no path to change a template's skeleton. A merchant who picks wrong must Save As into a new template with the right one. Accepted for this phase.

---

### D-67 · The UTILITY starter ships structurally complete and deliberately dataless

**Decision:** add a `UTILITY` value to `TemplateSkeleton`, a renderer branch, and five new block types — `CONSUMER_INFO`, `BILLING_PERIOD`, `METER_READING`, `TARIFF_SLABS`, `DUE_DATE` — declared in the shared manifest (D-30) and in the renderer, each rendering **nothing** until a data source exists. Seed it as a sixth `merchantId: null` starter. **No field is added to `Bill.snapshot` and the D-17/D-28 whitelist is not extended.**

**Reason:** the utility template was previously recorded as blocked (PENDING_WORK B5, SCOPE_v3) on a missing upstream data model — consumer number, billing period, meter readings, tariff slabs, due date have no source in either write path and no field in the snapshot. That block is real for the *data* and not for the *structure*. Shipping the structure now means the layout is designed and reviewed once, and the blocks light up with no template change when the data arrives.

**The precedent is deliberate, not improvised:** `SAVINGS` and `LOYALTY` already ship in the Retail starter and render nothing, recorded as expected gaps rather than bugs. This applies the same pattern knowingly.

**Why template-authored props cannot substitute:** `COUPON` carries its content in template props because a coupon headline is genuinely the same on every bill. A meter reading is per-bill data. Authoring it in the template would print the same reading on every customer's bill — worse than printing nothing, on a document a customer may rely on.

**What making this real would cost, so the deferral is legible:** extending the direct-API input contract, extending `Bill.snapshot`'s whitelist (carrying D-17's full Tier-1 weight, key-set test extended to any nested shape), and a product ruling on whether a utility bill is a `TAX_INVOICE` or a third `BillType`. That is a phase, not a task.

---

### D-68 · Starter-versus-mine is a DTO projection, not a column

**Decision:** the portal template DTO carries a boolean derived from `merchantId IS NULL`; the UI splits the list on it. **No column is added.**

**Reason:** `Template.merchantId` already encodes ownership exactly, and `templates.service.ts` already relies on it in every method — `save()` refuses `merchantId: null` rows, the old `clone()` required them, `archive()` uses direct equality with no `OR` so a starter is unreachable there at all. Adding an `origin` or `isStarter` column would be a second representation of a fact the FK already holds — the precise pattern D-39 rejected.

**Naming:** "starter" is the user-facing term for the shared catalogue. "Default" is reserved exclusively for D-60's two pointers. The two were conflated in early Phase-5 discussion and must not be again — a merchant's default may be a starter or one of their own, and a starter is not a default.

---

### D-69 · Resend: failed-only, stored recipient, a new row, refused while one is pending

**Decision:** `POST /portal/bills/:id/resend` creates a **new** `Broadcast` row with `status: PENDING`, `attempts: 0`, and the **stored** recipient from the failed row. The original row is never mutated. Permitted only when the target broadcast is `FAILED`, and refused while any `PENDING` broadcast already exists for that order. `MERCHANT_ADMIN` only. No recipient is ever read from the request body.

**Reason:** D-6 established the `Broadcast` table as an append-only queue, and D-7's `attempts` is per-broadcast retry state owned by the drainer. Resetting `attempts` or flipping the old row back to `PENDING` would conflate "the drainer retried" with "the merchant asked again" and would destroy the failure record. A new row keeps both facts.

**Failed-only** because a resend of a delivered bill is a different feature with a different question behind it (the customer lost the email), and it has no failure to remediate.

**Stored recipient only, non-negotiable:** accepting a merchant-supplied address turns the portal into "send any customer's bill to any address I choose" — a PII-egress abuse surface with no audit trail behind it and no product need. The recipient field is not read; a request carrying one has no effect, and F-series verification asserts that rather than assuming it.

**The pending-refusal is the rate limit.** Without it, a merchant can queue unbounded sends to a real customer's address with repeated clicks. A time-based limit was considered and rejected as a tunable with no evidence behind the number; "at most one delivery in flight per order" is structural, needs no constant, and is exactly the invariant that matters.

**This surfaces D-7's known limitation for the first time.** Rows exhausted past `MAX_BROADCAST_ATTEMPTS` while Mailhog was down have been permanently `FAILED` with no ops visibility since v1. R-1 makes them visible; R-2 makes them actionable. Neither changes the drainer.

---

### D-70 · `PiiExportAudit` is a prerequisite, append-only, and committed before the export is produced

**Decision:** a new `PiiExportAudit` model recording merchant, user, timestamp, row count and the filters used. No update, delete or upsert method exists for it anywhere in the codebase. The audit row is written and **committed before** the export is produced. E-1 ships before E-2; no export path ships without it.

**Reason:** D-48 recorded this as a literal precondition — "If export is ever built, it needs an audit table first, not after" — when it explained why single-record merchant reads are not exports and need no audit. Honouring that as a sequenced task rather than a follow-up is the whole point; a follow-up audit table is the same as no audit table for every export produced before it lands.

**Commit-first is the safe direction, chosen deliberately:** a streamed file response cannot be transactional with a database write, so one of the two failure modes has to be accepted. Audit-then-export can leave an audit row for an export that failed midway — an over-count. Export-then-audit can produce a file with no record of it — an under-count, meaning PII left the system unlogged. Over-counting is the failure a compliance reviewer can reason about.

**Scoped to exports, and it must stay that way.** This is not a general audit log. D-51's named gap — no login audit trail survives session reaping — is real and is **not** solved here; solving it means its own append-only table, decided on its own terms.

**Unanswered, recorded rather than defaulted:** retention period, who may read the table, and whether append-only is enforced at the database (revoking `UPDATE`/`DELETE`) or only by the absence of code paths. Locally it is the latter. Owner: Compliance + Security.

---

### D-71 · Export contact projection is the merchant's declared choice, recorded in the audit row; `MERCHANT_ADMIN` only

**Decision:** `GET /portal/bills/export.csv` requires an explicit `contact` parameter, either `masked` or `full`. **There is no default** — a missing or unrecognised value is `422` with no audit row and no file. The `PiiExportAudit` row records which projection was produced. The entire export route is `MERCHANT_ADMIN`; `STORE_STAFF` receives `403` for **both** projections.

**Reason:** D-48 established two projections of the same data — masked in the bill list, full in the bill detail — and both have a legitimate export use. A masked export answers "which bills, what amounts, what delivery status", which is reconciliation. A full export answers "my customer contacts, in my CRM", and the merchant is the data controller for contacts they captured themselves — D-48's own argument for showing them in the detail view. Choosing one for the merchant would either hand them a file of `98****3210` for the most likely reason they wanted it, or make every reconciliation export a full PII egress. Letting the merchant declare intent per export, and recording that declaration, is what turns D-70's audit table from a formality into the thing it exists to be: a record of who took contact details, when, and how many.

**No default, deliberately.** A default of `full` is unsafe. A default of `masked` is safe but produces a useless file for the merchant who wanted contacts, who then re-exports — doubling audit noise and training them to always pass `full`. Requiring the parameter makes every full-contact export a deliberate, recorded act, which is the only property that makes the audit trail worth reading.

**Cost accepted:** two serializer paths and two key-set tests instead of one. The key-set test is the enforcement — a `masked` export containing a raw contact, or a `full` export containing a field outside D-48's detail set, must fail the build.

**`MERCHANT_ADMIN` for the whole route, both projections.** D-50 gives `STORE_STAFF` read access to history, and an export is a read — but it is the read that produces a portable file which leaves the system entirely. Viewing one bill and carrying away fifty contacts are materially different acts, and this is the surface where that difference bites.

**Runner-up, rejected:** allowing `STORE_STAFF` the masked projection only. It is defensible — masked data is what they already see in the list — but it produces four permission states on one route (two roles × two projections), and a permission matrix is exactly the kind of thing that is easy to write and hard to verify. One rule, verified once by A-6's real `STORE_STAFF` principal, is worth more than a slightly more generous one that nobody can hold in their head.

**Consequence:** D-50's role gates become load-bearing for a data-egress path for the first time, having been written and never exercised since A-3. A-6's second seeded user is what proves them, and X-4 re-proves them.
### D-72 · Save As from the UTILITY starter is a deliberate D-31 422 until a utility body block exists

**Decision:** `POST /portal/templates/:id/save-as` runs the edited document
through `validateLayoutSchema` before persisting, exactly as `save()` does.
Because the UTILITY starter (D-67) deliberately ships without a visible
`ITEMS`/`CHARGES` block, Save As from `seed-template-utility` — the first
merchant-initiated write routed through the real validator, since seeding and
the old `clone()` both bypassed it — is rejected with
`422 INVALID_LAYOUT_SCHEMA` whose issue message is D-31's rule verbatim,
"A visible ITEMS or CHARGES block is required". No seed change, no new block,
no validator change. This stands until the utility-data-model phase adds a
real body block (or teaches D-31 that `TARIFF_SLABS` satisfies the body
requirement), at which point the starter becomes Save-As-able with no
F-series change.

**Reason:** F-2's row required the UTILITY spine gap to be *resolved* before
Save As could ship, and named two acceptable resolutions — succeed validated,
or "fail with a clear D-31-named error, not a silent/confusing rejection".
The alternatives were weighed and set aside:

- **Adding a real body block to the UTILITY seed** means either a visible
  `ITEMS` (which renders "Payment received / Amount unavailable" — it
  contradicts D-67's "renders nothing") or a new dataless `CHARGES` manifest
  entry + renderer branch + tests, an I-1-shaped addition on top of an already
  Tier-1 task, and it forces the deferred call on whether `CHARGES` is the
  real §4.3 charges block (needs the utility data model and GST-exempt tax
  treatment) or a second stub competing with `TARIFF_SLABS`.
- **Special-casing UTILITY in the validator** weakens D-31 for one skeleton;
  the clean form (teach D-31 that `TARIFF_SLABS` is a valid body) is still a
  validator change and belongs to the phase that gives `TARIFF_SLABS` real
  data.

The 422 is also the more honest outcome: a UTILITY template a merchant could
Save As today would render HEADER + FOOTER and nothing else — a broken
document. The five other starters all carry a visible `ITEMS`, so Save As
from them is unaffected.

**Consequence:** F-8's builder, opening the UTILITY starter and hitting Save
As, surfaces the server's named `INVALID_LAYOUT_SCHEMA` error telling the
merchant exactly which block is missing — no special client wording (F-2 Q7).

### D-73 · Create-from-scratch excludes UTILITY, and a name collision is a 409, not an auto-suffix

**Decision:** `POST /portal/templates` accepts `skeleton` ∈ { MINIMALIST,
COMPACT_THERMAL, TAX_COMPLIANT, RETAIL, RESTAURANT } only. `skeleton: 'UTILITY'`
is rejected with `422 SKELETON_NOT_AVAILABLE_FOR_CREATE`; an unrecognised value
gets `422 INVALID_SKELETON`. A `name` already held by one of the merchant's
live head templates is rejected with `409 TEMPLATE_NAME_TAKEN` — the F-1
allocator's `(1)`/`(2)` suffixing is **not** applied here.

**Reason — UTILITY:** D-66's minimal document is a visible HEADER + a visible
ITEMS. On a UTILITY skeleton that document passes `validateLayoutSchema`
mechanically but is broken by design: TEMPLATE_SYSTEM_v2 §4.3 has no ITEMS on
a utility bill, an ITEMS block renders "Amount unavailable", and there is no
dataless block to replace it with (TARIFF_SLABS does not satisfy D-31; CHARGES
has no manifest entry). This is the exact dead end D-72 identified for Save As
from `seed-template-utility`; this decision applies the same reasoning here
rather than take the same shortcut — fake an ITEMS block — a second time.
Until the utility data model exists, UTILITY is uniformly "declared but not
merchant-usable" from both the Save As and the create-from-scratch paths.

**Reason — name collision:** D-63 lists the allocator's consumers as "Save
As, rename via Save, and restore" and deliberately omits create. The
auto-suffix rationale (refusal traps a merchant renaming a template they can
no longer see) does not apply here: the merchant is in the create form itself
and can simply retype the name against a clear error.

**Reversal:** the utility-data-model phase that adds a real utility body
block removes this UTILITY rejection, D-72's Save-As 422, and unblocks a real
UTILITY option in F-8's skeleton picker — one coherent unlock.

### D-74 · Lineage membership is a runtime parentTemplateId walk, not a stored key

**Decision:** a template lineage has no root/lineage-key column. Operations that
need every row in a lineage (F-4 delete today; F-5 restore and any future
version-history view) compute membership at runtime by walking `parentTemplateId`
— up to the root (`parentTemplateId IS NULL`), then breadth-first back down —
inside the operation's transaction, with a hard row-count bound (MAX_LINEAGE).

**Reason:** the chain is created linearly (fork only from head, F-1/F-2/F-3) and
lineages are single-digit-sized, so a walk is a handful of indexed point lookups
in one transaction — cheaper to reason about on a Tier-1 destructive path than a
`WITH RECURSIVE` raw query, and it needs no schema change or backfill. Adding a
`rootTemplateId` column was considered and rejected: it is a second
representation of a fact `parentTemplateId` already holds (the D-39 pattern), it
must be backfilled by the same walk, and nothing reads it often enough to earn an
index. The BFS (rather than a linear chase) keeps the walk correct if a lineage
ever branches.

**Consequence:** F-4's "no bill on any version" check builds its `templateId IN
(…)` list from this walk. A head-only check is the named F-4 bug (D-64); the walk
is what prevents it.
### D-75 · Restore is scoped to head rows only — an archived non-head predecessor is not restorable

**Decision:** `restore()` is scoped to `{ id, merchantId, isHead: true, archivedAt: { not: null } }`. A row with `isHead: false` — even if it carries `archivedAt` (e.g. an `archivePrevious`-archived predecessor from `save()`) — is treated as out of scope and 404s like any other unmatched id (D-47), not as "not currently archived."

**Reason:** `restore()` and `listArchived()` must agree on what counts as an archived template, or a merchant could restore something they were never shown. `listArchived()` already filters to `isHead: true` (D-65) — only rows that reserved a name in the S-11 partial index and appear as one of the merchant's live archived entries. A non-head row is lineage history (a superseded version inside another template's lineage), not a distinct archivable item, and restoring it in place would not make it reappear in `list()` or `listArchived()` — it would silently become a live-but-invisible row, indistinguishable from a bug. Scoping it out entirely is more honest than restoring something into a state no view shows.

This does not change D-65's auto-suffix behavior for the case D-65 actually describes — restoring a genuine archived head whose name a live head has since taken. It narrows which rows are eligible for restore at all; it does not touch how a restore is resolved once a row is eligible.

**Rejected alternative:** re-heading a non-head row on restore (demote the current head, promote the restored row in its place). Rejected as out of scope for F-5 — it collides with fork-on-write's lineage semantics (a lineage has exactly one head, and swapping it is a materially different operation from clearing `archivedAt`) and would need its own decision if a future task wants "restore a specific historical version as the new head."

**Consequence:** the F-5 collision test originally written for this path (restoring a non-head row into a taken name, expecting an auto-suffix) no longer applies — that row is now a 404 before any name logic runs. Replaced with a test confirming an archive()-archived head keeps its exact name and that name stays reserved (a `create()` attempt with it returns `409 TEMPLATE_NAME_TAKEN`) for as long as it's archived.

### D-76 · Two-pointer defaults DTO is a derived projection; setDefault returns pointer ids only, never the Merchant row

**Decision:** F-6 surfaces both default pointers to the portal through two narrow shapes, one read and one write.

`GET /portal/templates/defaults` returns `{ receipt: {id,name} | null, taxInvoice: {id,name} | null }` — a derived projection of `Merchant.defaultReceiptTemplateId` / `defaultTaxInvoiceTemplateId` (D-60), resolved to names. No `Template.isDefault` column, no stored flag — consistent with D-39 and the D-68 "starter-vs-mine is a projection, not a column" precedent. The dashboard's "Default templates" module reads this; F-8's per-row badge will derive from the same two pointers.

`POST /portal/templates/:id/set-default` now returns exactly `{ defaultReceiptTemplateId, defaultTaxInvoiceTemplateId }`. It previously returned `prisma.merchant.update(...)` — the raw `Merchant` row, carrying `secretKeyEnc` (the JioPay HMAC secret, D-2/D-3) plus `gstin`, address lines, and support contacts — to any authenticated `MERCHANT_ADMIN`. Shipped unnoticed in W-3. The fix is enforced at the writer (`TemplatesService.setDefault` constructs the two-key object explicitly; the Prisma `select` is defence in depth), the same boundary-at-the-writer discipline as D-48 and the L-2 whitelist, and is locked by a key-set test that fails the build if any other field appears.

**Reason:** D-60 already made the two pointers the single source of truth for "the default per bill type"; F-6 needs to show and change them without inventing a second representation. A `Merchant`-row return is exactly the kind of over-broad response a serializer would normally catch — this project has no `ClassSerializerInterceptor` and no Prisma `omit`, so the only guard is what the method chooses to return, the same conclusion D-17/D-28 reached for `Bill.snapshot`.

**Archived-as-default is a `404`, not a named `422`:** `setDefault`'s scope query already carries `archivedAt: null`, so an archived template falls out of scope and is a `404` — indistinguishable from another merchant's or a nonexistent id (D-47). A non-head template keeps its named `422 CANNOT_SET_NON_HEAD_AS_DEFAULT`. The asymmetry is deliberate: the F-6 dashboard picker and F-8's list picker only ever offer live head templates as candidates, so the archived case is only reachable by a stale or crafted request, where the `404` (reveals nothing) is the better answer.

**Not in F-6, explicitly:** the direct-API (`POST /v1/bills`) read-through of `defaultTaxInvoiceTemplateId`. `resolveTaxInvoiceTemplate` still runs its positional oldest-by-`createdAt` fallback chain; replacing it — with the pointer read, `422 TEMPLATE_BILL_TYPE_MISMATCH`, and the fallback-reason field — is F-7 / D-61, a one-way door per D-27. F-6 proves only that the pointer is written correctly; F-7 proves it is read.

`getDefaultTemplateId()` (receipt-only, F-2's decision) is untouched — it feeds the "Create invoice" shortcut and `list()`'s single-default DTO; F-8 reshapes `list()`'s response to carry both pointers. F-6 adds `getDefaults()` alongside rather than widening the old method, avoiding shaping that response twice.

### D-77 · Direct-API template resolution — response shape and the null-default edge (executes D-61)

**Decision:** `POST /v1/bills` resolves `template_id` exactly as D-61 specifies. This entry pins the five things D-61 left unspecified.

**1 · Response shape.** On a fallback the body gains a nested object, absent (not `null`) on every other path:

```json
"template_fallback": { "reason": "TEMPLATE_ID_NOT_FOUND", "requested_template_id": "<what the caller sent>" }
```

`template_id_used` is unchanged — same key, same string type, same meaning (the id the bill was rendered from). Existing callers parsing only that field are unaffected; this is the one-way-door invariant (D-27/ADR-6). `reason` is a single-value enum string, not a boolean, so a future reason is additive. The marker appears only when the caller supplied a `template_id` that did not resolve (unknown, or another merchant's — never distinguished, D-47). Sending no `template_id` and getting the default is the base path (D-13 lineage), not a fallback — no marker.

**2 · Null `defaultTaxInvoiceTemplateId`.** The seed sets `Merchant.defaultTaxInvoiceTemplateId = 'seed-template-tax-invoice'` (the shared TAX_COMPLIANT starter — a default may point at a starter, D-68) alongside the receipt pointer, idempotently. This is the honest analog of D-60's "no row losing its default" for the tax-invoice side, and it keeps any no-`template_id` caller (`sample-bill.json`) working. When the pointer is genuinely null (a merchant provisioned without a seed): `422 { error_code: 'NO_DEFAULT_TAX_INVOICE_TEMPLATE' }`, zero writes. No silent last-resort substitution — that is exactly the invisible-substitution failure D-61 exists to prevent, and the response's fallback marker could not honestly describe it.

**3 · Replay omits the marker.** A repeated `external_transaction_id` returns 200 with the existing bill and no `template_fallback`, even if the original 201 carried one. Template resolution never runs on a replay (`createBill` checks `externalTransactionId` before it), and the marker is a diagnostic of the creation act, not persisted. Accepted asymmetry — persisting it would need an `Order` column for a field nothing reads back.

**4 · The seed change.** `seed.ts` sets both default pointers in one `merchant.update`; re-seed restores this baseline (neither pointer is guarded — same as the receipt line since S-10). The stale seed comments that explained seed ordering in terms of the removed positional chain (`seed-template-retail`, `seed-template-utility`) are trimmed.

**5 · `archivedAt: null` on the caller-supplied lookup.** The lookup for a caller's `template_id` is `{ id, archivedAt: null, OR: [{ merchantId }, { merchantId: null }] }` — an archived template is not "visible" (D-61), so an archived id falls back to the default like an unknown one. The default-pointer lookup is not re-filtered on `archivedAt`/`billType` — `setDefault` (D-76) + `archive()` (D-33/D-76) + `deleteLineage` (D-64) already guarantee that pointer holds a live, non-archived TAX_INVOICE head; a violation throws a plain `Error` (integrity bug), never a 422.

Supersedes the last of D-13's v1 scoping. Unchanged: the JioPay callback path (`defaultReceiptTemplateId`, no override, D-61); the D-27 replay contract; `Bill.snapshot` / the D-28 whitelist.

### D-78 · GET /portal/deliveries — response envelope, and billId alongside D-48's contact whitelist

**Decision:** R-1's `GET /portal/deliveries` returns a fixed three-key envelope:

```json
{
  "counts":      { "PENDING": 1, "SENT": 3, "FAILED": 2 },
  "maxAttempts": 5,
  "failed":      [ { "channel": "...", "status": "FAILED", "attempts": 5, "sentAt": null, "recipientMasked": "...", "billId": "..." } ]
}
```

`counts` is zero-filled — every status present even at 0. `maxAttempts` is top-level, not per-item. `failed[]` items carry exactly six keys.

**1 · Zero-filled counts.** `prisma.broadcast.groupBy({ by: ['status'], where: { order: { merchantId } } })` returns only statuses that have ≥1 row; the serializer overlays them onto `{ PENDING: 0, SENT: 0, FAILED: 0 }`. So the response always carries all three, and it reconciles exactly to `SELECT status, count(*) FROM "Broadcast" b JOIN "Order" o ON b."orderId"=o.id WHERE o."merchantId"=$1 GROUP BY status` (which simply omits the zero rows). `Broadcast` has no `merchantId` column — every query in this service is scoped through the relation filter `order: { merchantId }` (`Broadcast.orderId` → `Order.merchantId`).

**2 · `maxAttempts` is top-level, not a per-item field.** It is one config constant — the D-7 retry ceiling the drainer enforces — read from the single shared source `resolveMaxBroadcastAttempts()` (extracted from `broadcast-drainer.service.ts` to `broadcast-max-attempts.util.ts`, so the two call sites cannot drift). `attempts >= maxAttempts` on a `FAILED` row means the drainer has permanently given up (D-69: "R-1 makes them visible"); below it, still retrying. Putting it top-level keeps the per-item DTO at exactly D-48's field count.

**3 · `billId` on the failed item is NOT a D-48 violation.** D-48's whitelist bounds contact/PII exposure — it is a rule about `recipient` and customer identifiers, not about every field on the DTO. `billId` is a foreign key: it carries no PII, appears already on every `/portal/bills` response a `STORE_STAFF` can read, and exists solely so the failed-deliveries list can link to `/portal/bills/:id`, where R-2's resend lives — the "R-1 visible → R-2 actionable" pipeline D-69 describes needs that link. The key-set test therefore asserts exactly `{channel, status, attempts, sentAt, recipientMasked, billId}` — six keys — and explicitly bans `recipient`, `error`, `id`, `orderId`, `order`. The distinction this decision draws: D-48 forbids a second copy of contact data, not a reference to the bill it belongs to.

**4 · Masking reuses H-3's `maskBroadcastRecipient(channel, recipient)`** (`EMAIL` → `maskEmailPortal`, else → `maskMobilePortal`), extracted to `portal-contact-mask.util.ts` and imported by both `PortalBillsService.findOne` and `PortalDeliveriesService`. No new masking logic. `Broadcast.error` (which stores a log-masked recipient) is never selected.

**5 · Read-tier, `MERCHANT_ADMIN` + `STORE_STAFF`** — same as `/portal/bills` (D-50). The masked recipient shown here is a strict subset of what `STORE_STAFF` already sees in the bill list/detail. The write action (R-2 resend) is `MERCHANT_ADMIN` only; that asymmetry is R-2's.

**6 · No pagination; a 200-row cap on `failed[]`.** A merchant's `FAILED` count should be tiny (D-7 tolerates ~9 min of outage). The cap is insurance against an unbounded `findMany`, not a page size — the `counts.FAILED` value is uncapped. Ordering: `createdAt desc` (uses `@@index([status, createdAt])`).

**Unchanged:** `Bill.snapshot`, the L-2 whitelist, the public bill page, the drainer's behaviour (extracting `resolveMaxBroadcastAttempts` is a pure move — the drainer's boot-time validation test still passes).

### D-79 · Resend implementation — no-body targeting, the partial index as D-69's structural rate limit, error codes

**Decision:** `POST /portal/bills/:id/resend` (D-69) is implemented as follows.

**1 · No request body is read.** The route has no `@Body` parameter — a recipient (or `broadcastId`, or anything) in the request is structurally unreadable, not merely ignored. This is what makes D-69's "no recipient is ever read from the request body" and R-2's "a request body carrying a recipient field has no effect" true by construction rather than by discipline.

**2 · Target = the most-recent FAILED broadcast on the order.** With no `broadcastId` in the path or body, R-2 resolves the target itself: `broadcasts.filter(FAILED).sort(createdAt desc)[0]`. This is well-defined because P-1/P-2 create exactly one broadcast per order (via `Merchant.defaultChannel`), so every later FAILED row for that order is a prior resend to the same channel+recipient — "most recent FAILED" and "any FAILED" resolve to the identical destination. The new row copies `channel` and the stored raw `recipient` from that row.

**3 · The partial unique index is D-69's "structural" rate limit.** D-69 calls "at most one delivery in flight per order" structural.

`migrations/20260910200000_r2_broadcast_one_pending_per_order/`:
```sql
CREATE UNIQUE INDEX "Broadcast_orderId_pending_key" ON "Broadcast" ("orderId") WHERE "status" = 'PENDING';
```

Hand-written SQL (Prisma v6 can't express a partial unique index — S-11 precedent; `schema.prisma` carries only a comment, the index will not round-trip through a future `migrate dev`). Safe against every existing writer: P-1/P-2 create exactly one PENDING per order at order-creation, the drainer only UPDATEs. R-2's `resend()` runs a COUNT-based pre-check for the friendly 422, and catches the index's `P2002` (a concurrent double-click that beat the pre-check) as the same `422 RESEND_ALREADY_PENDING` — indistinguishable to the caller. SENT/FAILED rows are unconstrained (D-6's append-only queue, D-7's retry history).

**4 · Stable error codes.** `RESEND_ALREADY_PENDING` (a PENDING broadcast exists for the order — checked at order scope, any channel, any recipient, per D-69) and `NO_FAILED_BROADCAST` (no FAILED row on the order — covers both "only SENT" and "no broadcasts at all", one code, one message). Both carry a human message (F-8's "surface the server's named error verbatim" depends on this). Cross-merchant / nonexistent `billId` → `404` (D-47), no distinguishing body.

**5 · Response:** `{ resent: true, channel }` — `channel` is non-PII (tells the UI "re-queued the email/SMS"); no recipient, masked or otherwise. `201` (Nest default). `resend()` lives on `PortalDeliveriesService` (broadcast domain), the whole thing in one `$transaction`.

**6 · `attempts` is not a gate (NIT-2).** A FAILED row is resendable regardless of its `attempts` count — even one still below `MAX_BROADCAST_ATTEMPTS` that the drainer would retry on its own. The merchant asking explicitly is a distinct signal from the drainer's schedule (D-69's whole rationale for a new row over a retry). This is deliberate, not a missing check.

**7 · No new send logic.** `resend()` writes `status: PENDING, attempts: 0` — a row matching the drainer's candidate query (first branch, backoff-exempt). The existing `@Cron` drainer delivers it on its next tick. D-69: "Neither changes the drainer." The old FAILED row is only ever read — never updated, never deleted — preserving the failure history R-1 surfaces.

### D-80 · PiiExportAudit write path — PiiExportAuditService.record(), a service not a route

**Decision:** E-1 builds `PiiExportAuditService.record(input)` — one method, no controller, no route. E-2's `GET /portal/bills/export.csv` is the only caller.

**1 · Service, not a route.** `record()` is a reusable primitive. Any export path (E-2, or a future per-customer export) must call it before producing PII output; forgetting to is a compliance hole with no compile-time signal, so the D-70 sequencing (E-1 ships before E-2, no export path without it) is the guard.

**2 · commit == promise-resolved is the sequencing primitive.** A single Prisma `create` is its own implicit transaction; `record()`'s promise resolving is the commit. No explicit `$transaction` wrapper (it adds nothing for one write and holds a connection longer). E-2's obligation: `await auditService.record(...)` to completion, then stream the first CSV byte; if `record()` rejects, refuse the export entirely (500, zero bytes) — D-48's "precondition": no committed audit row, no export.

**3 · E-1's verify is the weak form; the full guarantee is E-2's.** E-1 asserts only "a committed audit row survives a subsequent thrown error in the same flow." The full "a forced failure after the audit commit leaves an orphan row and no file" requires the streaming path and is E-2's to prove end to end — E-1 has no export to fail. The E-1 roadmap verify line is read as the partial form.

**4 · The filters JSON contract (`ExportAuditFilters`).** `{ dateFrom?: string; dateTo?: string; billType?: string; source?: string }` — plain strings, the values the merchant actually asked for, `{}` when no filters were applied (the column is non-nullable). E-2 maps its parsed query to this shape; E-1 stores it verbatim. E-1 defines neither the filter semantics nor the query — a compliance reader and E-2 agree on this exact shape.

**5 · `rowCount` = "the count of data rows the caller declares it exported."** E-1 records it faithfully and does not compute it — E-2 owns the merchant-scoped, filter-matched bill query and passes the count. No duplication of H-1's where-builder in E-1. `rowCount: 0` is valid (an empty export is still an audited egress act). Backstop validation: non-negative integer or throw, no row written.

**6 · No authorization here.** `record()` records whatever principal it is handed (`merchantId`, `userId` as typed scalars, sourced by E-2 from `MerchantContext` — never a request field). The `MERCHANT_ADMIN`-only gate is E-2's route (`@Roles`, per D-71). A future export route that forgets its own `@Roles` would write audit rows for a `STORE_STAFF` export — E-1 trusts its caller. Backstop validation: `contactProjection` ∈ `{masked, full}` or throw.

**7 · Append-only is enforced locally by absence of code paths only** (D-70's accepted gap — DB-level `REVOKE` is Compliance's, deferred). The enforcement is three tests that stay green forever: a method-surface assertion (`PiiExportAuditService.prototype` exposes exactly `record`), a repo-wide grep over production `.ts` (no `piiExportAudit.{update,updateMany,delete,deleteMany,upsert}` — `*.spec.ts` excluded, since integration teardown must delete its own scratch rows past the `ON DELETE RESTRICT` FKs), and a schema assertion (`PiiExportAudit` has no `@updatedAt`). A migration adding a mutation path, or an update method anywhere, trips these.

**Module:** registered in `bills.module.ts` (export is bill-history-adjacent; E-2's controller lands there). `record()` returns `{ id, createdAt }` so E-2 can assert "exactly one row, this id."

### D-81 · CSV export — column set, unbounded/materialized, escaping, error codes, shared extractions

**Decision:** E-2's `GET /portal/bills/export.csv` executes D-70 (audit-first) and D-71 (contact projection, `MERCHANT_ADMIN`) with the following pinned.

**1 · Column set** — 10 columns, identical between projections except the two contact columns.

Both: `bill_id, created_at, bill_type, source, invoice_number, total_paise, currency, delivery_status`.

`masked` adds `customer_mobile_masked, customer_email_masked` (via H-1's `maskMobilePortal`/`maskEmailPortal`).

`full` adds `customer_mobile, customer_email` — the raw `Order.customerMobile_pii`/`customerEmail_pii`.

`delivery_status` is the most-recent `Broadcast.status` for the bill's order (`''` when the order has no broadcast — D-12). `total_paise` is a BigInt→string, never a number.

"exactly D-48's detail field set" (E-2 verify) means, for `full`: raw mobile + raw email + `Broadcast.status` as the scalar `delivery_status` — and nothing else. Not the full `PortalBillDetailDto`: no line items, no `merchantGstin`, no subtotals/tax columns, no `broadcasts[]` array, no raw `Broadcast.recipient`. A stray column fails the serializer key-set test.

**2 · Unbounded, materialized, buffered** — not streamed, no row cap. An export's purpose is the whole result set (D-71's reconciliation / CRM use cases), and the E-2 verify's "cross-checked against `SELECT count(*)`" structurally requires file rows == count. R-1's 200-cap reasoning (a dashboard, "a merchant almost never needs 50 numbers at once") is the opposite of an export's use. `PortalBillsService.exportRows()` runs a single `findMany` with no `take`, and the controller buffers the full CSV string before `res.send()`. Buffered (not a DB cursor) because E-1's contract needs the exact `rowCount` before the audit commits (D-70), which a cursor cannot give without a separate `COUNT`; and buffering is what makes the D-80 §3 orphan-row failure testable. Escape hatch, recorded: if memory ever bites at real volume, the future path is a cursor + `COUNT`-first accepting D-70's over-count.

**3 · CSV escaping + formula-injection guard.** `csvField()` (in `bills-export-csv.util.ts`): RFC 4180 — a field containing `,`, `"`, `\r`, or `\n` is wrapped in `"…"` with internal `"` doubled; and a field whose first character is `= + - @ \t \r` is prefixed with `'` so a spreadsheet does not evaluate it as a formula. Applied to every field; the only ones that can carry hostile text are `invoice_number` (caller-supplied, D-20) and the contact columns. Line endings are `\r\n` with a trailing newline.

**4 · Two stable error codes.** `422 { error_code: 'INVALID_CONTACT_PARAM' }` for a missing or unrecognised `contact` — checked first in the controller, before any DB activity or audit write (D-70/D-71). Bad `dateFrom`/`dateTo`/`billType`/`source` → `400` (H-1's `BadRequestException` behaviour, unchanged). `record()` rejecting → plain `500`, zero CSV bytes, never a partial file, never a `2xx` (D-80 §2).

**5 · Shared extraction units** (D-80 "no duplication"). `portal-bills-filters.util.ts` — `parseIsoDate`/`parseBillType`/`parseSource`/`parseLimit`, moved out of `portal-bills.controller.ts` verbatim; both `PortalBillsController.list` and `exportCsv` import them. `buildBillFilterWhere(merchantId, filters)` — exported from `portal-bills.service.ts`, the `merchantId` + `billType` + `createdAt` + `order.source` where object extracted from `list()`'s inline body; `list()` and `exportRows()` build it one way. Zero behaviour change; H-1's existing tests re-verify.

**6 · Sequencing** (D-80 §2), implemented in `exportCsv` in this order: contact `422` (zero DB) → `parse*` filters (`400`) → `exportRows()` materialize → `rowCount = rows.length` → normalize filters to `ExportAuditFilters` (only keys the merchant sent, `{}` if none) → `await auditService.record(...)` → serialize → set `text/csv` + `Content-Disposition: attachment; filename="bills-export-<merchant-8>-<yyyymmdd>.csv"` → `res.send(csv)`. A serializer failure after step 5 → `500`, no file, orphan audit row (D-80 §3, accepted).

**Web:** the browser cannot hit `:4000/portal/bills/export.csv` directly (httpOnly session cookie, cross-origin), so a Next GET proxy `app/portal/bills/export/route.ts` forwards the cookie and pipes the CSV + its headers back. Two `MERCHANT_ADMIN`-only "Download CSV" links (masked / full) on `/portal/bills`, carrying the current filters.

### D-82 · Phase 6 is gated: the base is cleaned before any feature work

**Decision:** Phase 6 runs in four stages — A clean the base, B analytics, C surveys and ratings, D response analytics — and a stage does not begin until the previous one is verified. Stage A closes all eight defects deferred across Phases 1–5.

**Reason:** each individual deferral was correct; the accumulation is not. Eight items now stand between "five phases complete and verified" and "usable by a merchant," and they have been re-recorded three times without being fixed, which is a slower form of forgetting them. The gate is specific rather than hygienic: Stage C adds the first unauthenticated write endpoint in the system, and a new public attack surface must land on a base with no known defects — particularly not on top of a logger that leaks PII through Prisma's own exception messages.

**Consequence:** Phase 6 is the largest phase so far. The stage boundaries are the honest checkpoints; the phase is not done until D is.

### D-83 · PG-path sale time: strict yyyyMMddHHmmss, interpreted in IST through one constant, always recomputable

**Decision:** `Order.saleAt` is populated on the callback path by parsing `paymentDateTime`. The parse accepts **exactly** 14 digits in `yyyyMMddHHmmss` and rejects everything else; the value is interpreted in a single named `IST_ZONE` constant. `Order.paymentDateTime` keeps the raw string permanently and is never modified. The backfill is idempotent and recomputes purely from the raw string. No column is added — `Order.saleAt` already exists and is nullable.

**Reason:** the format is documented only in a schema comment and `DATA_MODEL_v1`; no vendor specification exists anywhere in the repository, and every fixture in the codebase uses one identical value. Worse, our own `demo.service.ts` generates the field from `toISOString()` — UTC — so validating a parser against our fixtures would validate it against our own guess. IST was confirmed separately; the constant exists so that a wrong answer is a one-line correction rather than an archaeology exercise.

A permissive parser is worse than a narrow one here: a coerced date is indistinguishable from a correct one until someone audits a chart. Strict rejection surfaces deviant values at backfill time, which is the cheapest moment to find them.

**Because `saleAt` is derived and the raw string is retained, nothing is lost by being wrong** — which is what makes shipping ahead of a vendor specification acceptable rather than reckless.

**Open, not blocking:** the DTO also declares `TransmissionDateTime`, which is accepted and stored nowhere. It may be the more honest event time. Unasked of JioPay; unused here.

### D-84 · An unparseable sale time is null and visible, never silently dropped

**Decision:** when `paymentDateTime` does not parse, `Order.saleAt` stays null. Such bills are excluded from every sale-time series and reported as an explicit `unattributedCount` alongside the charts, displayed in the UI rather than hidden.

**Reason:** the failure mode being avoided is a merchant reconciling their own revenue against a chart that is quietly missing rows. An excluded-and-counted bill is a visible discrepancy the merchant can ask about; an excluded-and-uncounted bill is a wrong number that looks right. Falling back to `createdAt` was rejected for the same reason D-61 rejected silent template substitution: it produces a plausible answer to a question that was not asked.

### D-85 · Analytics reads `Bill` for money, groups every aggregate by currency, and buckets in fixed IST

**Decision:** money aggregates read `Bill.totalPaise` and the tax columns, joined to `Order` for `source` and `saleAt`. **Every** aggregate is grouped by currency with no exception. Time buckets are computed in a fixed IST constant. Averages are computed in `BigInt` paise with a single half-up rounding at the presentation edge, and are labelled derived rather than authoritative.

**Reason — `Bill`, not `Order`:** `Order.amountPaise` is nullable by D-15 (non-success orders, and success callbacks with unparseable amounts). A `Bill` exists only where an amount parsed, so reading `Bill` removes the null case structurally instead of filtering it away in every query.

**Reason — currency always:** `Order.currency` is caller-supplied and validated ISO-4217 on the direct path (BR-4), so mixed currencies are possible today. Summing across them produces a number with no meaning, and the bug would be invisible until an international transaction appeared. Grouping unconditionally means the correct behaviour is the default rather than something a future query must remember.

**Reason — fixed IST:** every merchant is Indian and JioPay is India-only. A `Merchant.timezone` column is a migration that buys nothing until that changes; confining the constant to one module makes adding one a contained change.

### D-86 · Bill-sent time is derived from `Broadcast`, never stored

**Decision:** "when was this bill sent" is computed as the **first successful** `Broadcast.sentAt` for the bill's order. No field is added to `Bill`.

**Reason:** R-2's resend means one bill can have several broadcasts, so a stored field would need a rule about which send wins and a write path to maintain it — a second representation of a fact `Broadcast` already holds (the D-39 pattern). First-successful is chosen over latest because the question is "when did the customer first get it", and a resend is remediation of a delivery that failed, not a new delivery event.

### D-87 · Renderer bug fixes legitimately change how issued bills look; §7 freezes content, not pixels

**Decision:** Q-5 and Q-6 change how already-issued `TAX_COMPLIANT` bills render, and this is correct, not a violation. `TEMPLATE_SYSTEM_v2` §7 and `Bill.layoutSnapshot` guarantee that the **block list and its data bindings** are frozen at issue. They do not, and never did, guarantee the renderer's visual output is frozen.

**Reason:** the alternative is absurd on inspection — it would mean a rendering bug, once shipped, could never be fixed for any bill that had already been issued, and every fix would need a versioned renderer keyed to issue date. What §7 protects is that editing a *template* cannot change what an issued bill **says**. A `TAX_COMPLIANT` bill showing CGST and SGST as separate rows instead of a forbidden column matrix says the same thing, correctly.

**Boundary, stated so it is not stretched:** this permits fixes that change presentation of unchanged data. It does not permit a renderer change that alters which data a block reads, adds a field, or changes a computed figure — those are content changes and belong behind a snapshot version.

### D-88 · `invoiceDate` extends the D-28 whitelist by exactly one field, for new bills only

**Decision:** `invoiceDate` is added to `Bill.snapshot` for `TAX_INVOICE` bills at creation, sourced from the direct payload. Existing bills are **not** backfilled; `BILL_META` and `TAX_COMPLIANT` render the date when present and stay silent when absent — the behaviour they already have. The D-28 key-set test is updated to expect exactly one new field.

**Reason:** the whitelist is the PII boundary (D-17), so extending it is Tier-1 regardless of how innocuous the field is, and the extension is stated as exactly one field so the test remains a real constraint rather than a formality. `invoiceDate` is a merchant-supplied document fact carrying no customer information — checked individually, per D-28's own discipline, not assumed from its name.

**No backfill:** existing `snapshot` values are immutable by §7. A bill issued without a date genuinely was issued without one, and fabricating one now would be inventing a fact — the same reasoning that kept the field out until a real source existed.

**Consequence:** for a period, some tax invoices show a date and older ones do not. That is an honest representation of history.

### D-89 · Survey and rating definitions are snapshotted into `layoutSnapshot` at issue

**Decision:** the `SURVEY` and `RATING` blocks carry an id in the template. At bill creation, **both** write paths resolve that id and freeze the full definition — questions, types, order, appearance — into `Bill.layoutSnapshot`. The renderer continues to read only the snapshot and performs no database access for bill content.

**Reason:** the renderer reading only `layoutSnapshot` is what makes §7's guarantee true rather than aspirational. A live `surveyId` lookup would be the first time an issued bill's content could change after issue, and it would require giving the renderer database access it has never had. The current `SURVEY` block already freezes its props this way; this preserves that property while making the content merchant-managed.

**Rejected:** live resolution at render time. It buys a merchant the ability to fix a typo on already-issued bills, at the cost of the one invariant that has held since Phase 3.

**Consequence:** a response answers the questions frozen on **its** bill, so response analytics must group by question version (N-4). A deleted survey does not break an issued bill — the snapshot is self-sufficient.

### D-90 · Survey anonymity is chosen at creation and is immutable; anonymous responses store a hash, never a bill reference

**Decision:** each survey is anonymous or attributable, chosen at creation, and **no route accepts a change to it** afterwards. An attributable response stores `billId`. An anonymous response stores only a one-way `dedupeHash` derived from the bill identifier and a per-survey salt, and **never** `billId`. A check constraint enforces that exactly one of the two is present.

**Reason:** anonymity cannot be applied retroactively. Once responses carry a bill link, removing it does not un-know what was already stored or already visible; and flipping the setting mid-life produces one dataset with two meanings and no way to tell which rows mean which. Fixing it at creation is the only honest form.

The hash exists because one-response-per-bill still has to be enforced for anonymous surveys. Storing a one-way digest allows the duplicate check without storing the link — the property being protected is that the table cannot be read backwards to a customer, not that duplicates are tolerated.

**Enforced at the database:** the constraint is a check, not application logic, for the same reason D-63's uniqueness is an index — an invariant this consequential should be impossible to violate, not merely discouraged.

### D-91 · Rating is a separate module from Survey; the public capture envelope is shared

**Decision:** `Rating` is its own entity with its own editor, its own block, its own response table and its own analytics, usable with no survey present. Surveys and ratings **share one public capture controller** and one set of anti-abuse defences.

**Reason for separation:** a merchant wanting a one-tap star rating should not have to construct a survey, and the two have genuinely different editing and reporting shapes.

**Cost, recorded honestly:** a rating is structurally a single-question survey, so this is two implementations of one idea — two entities, two response tables, two analytics pipelines, and two places any future change to response handling must be made. Modelling rating as a single-question survey underneath, surfaced as a simpler control, was considered and set aside in favour of the cleaner merchant-facing separation. If the two pipelines start drifting, this entry is where that cost was accepted.

**Reason the capture path is shared:** the unauthenticated endpoint is the security-critical surface. Duplicating rate limiting, replay defence and enumeration-resistance would mean two places to get them right and two places to get them wrong. Separating the domain does not require separating the defences.

**Consequence:** rating analytics and survey rating-questions are counted separately and never merged — they are different instruments that happen to produce similar numbers.

### D-92 · The public response endpoint's security envelope

**Decision:** `POST /r/:identifier/responses` is unauthenticated and keyed on the bill's existing unguessable link identifier — the same capability the public bill page already relies on. It enforces: one response per bill per instrument (`409` on a second, zero writes); a rate limit per identifier and per source address (`429`, zero writes); `404` for an unknown identifier with a body **identical** to the public bill page's, so the endpoint reveals nothing the page does not; strict body validation rejecting unknown fields rather than storing them; and no read or write of any `Order`, `Bill` or contact field.

**Reason:** this is the first unauthenticated write in the system, and every property above closes a way it could be turned into something else — an enumeration oracle, a spam sink, a stuffing target, or a path into customer data. The link identifier is used as the capability because the system already treats it as one; inventing a second secret would create a second thing to leak.

**`404` matching the bill page exactly** matters more than it looks: a distinguishable response here would let an attacker enumerate valid bill identifiers against an endpoint with no session and no rate history, which is materially easier than probing the page.

**Accepted limitation:** the rate limit is in-process, so it does not survive a restart or span instances. Single-instance local deployment makes that adequate today; a distributed limiter is the upgrade path and is named here so it is not rediscovered.

### D-93 · Free text is stored verbatim, rendered inert, length-capped, and not moderated in v6

**Decision:** free-text responses are stored exactly as submitted, length-capped at submission, escaped at every render, never interpreted as markup or formulas, and never aggregated — they are listed. No moderation queue, no filtering, no export.

**Reason:** this is the first customer-written content this system displays to a merchant, so the rendering path is where it can hurt. Escaping at render rather than sanitising at write preserves what the customer actually said — the merchant's reason for asking — while making it inert everywhere it is shown. The same formula-injection guard D-81 applies to CSV fields applies anywhere free text reaches a spreadsheet.

**Not aggregated** because averaging prose is meaningless; the analytics surface lists responses and counts them.

**Deferred, not designed:** moderation, and export of responses. Export in particular is a new egress surface with its own D-70/D-71 questions — the audit machinery exists, the decision does not.

### D-94 · Log-scrubbing Prisma errors requires new free-text PII detection; the star-out functions themselves are unchanged

**Decision:** Q-2's exception filter reuses `mask.util.ts`'s `maskMobile`/`maskEmail` for the actual masking transformation — no new star-out/slicing logic is written, and `portal-contact-mask.util.ts`'s functions remain untouched and unused here (wrong purpose per that file's own comment). What is new is a small regex-based scan that finds mobile-shaped and email-shaped substrings inside a Prisma error's free-form `.message`/`.stack`/`.meta` text, then calls the existing maskers on each match. The filter catches all four non-`HttpException` Prisma error classes defensively — `PrismaClientKnownRequestError`, `PrismaClientValidationError`, `PrismaClientUnknownRequestError`, `PrismaClientRustPanicError` — even though only the first two were proven live to carry raw PII; the cost of scrubbing an already-safe error is zero, and absence of a live-triggered leak in the other two is not proof of safety.

**Reason, and why this is structurally different from every other masking call site in this codebase:** every existing masking call (`mask.util.ts` in log lines, `portal-contact-mask.util.ts` in DTOs) masks a known-channel value — the caller already knows "this string is a mobile number" or "this string is an email" and slices it accordingly. A Prisma error's message is unstructured text that may contain such a value anywhere inside a much larger string — confirmed live: `PrismaClientValidationError` pretty-prints the entire arguments tree (including `customerMobile_pii`/`customerEmail_pii` verbatim) into `.message`, and a Postgres-level error (`P2010`) embeds a raw value inside `meta.message`, one level nested inside `meta`. Neither case hands the filter a pre-identified value to mask — it must first find one. That detection step (a regex scan over free text) is genuinely new code; treating it as a violation of "no new masking logic" would make the task impossible, since finding PII in unstructured text and masking a known field are different operations. The masking algorithm itself is not duplicated: every match found is masked by calling the existing `maskMobile`/`maskEmail`, never a second star-out implementation.

**Mechanism, since it's load-bearing for what "scrubbed" means:** confirmed by reading `@nestjs/core`'s `BaseExceptionFilter` source directly — Nest's default handling of a non-`HttpException` calls `logger.error(exception.message, exception.stack)`, i.e. both arguments are logged, and `Error.prototype.stack` conventionally begins with `<name>: <message>`, so the same PII dump that appears in `.message` is also present at the head of `.stack`. Scrubbing `.message` alone is therefore insufficient — `.stack` must be scrubbed too, or the client-response-preserving `super.catch()` delegation would still leak PII through the log line's second argument. `.meta`, when present, is walked recursively (not just a hardcoded `meta.target`/`meta.message` check) since Prisma doesn't guarantee a fixed shape across error codes/versions — every string value found anywhere in `.meta` is scrubbed the same way as `.message`/`.stack`.

**Accepted trade-off:** the detection regex is necessarily more permissive than the structured maskers (which never validate format). This will occasionally star-out non-PII digit runs (an amount, a `txnId` fragment) that happen to look mobile-shaped. For a PII-safety filter, over-masking is the correct failure direction — accepted deliberately, not a missed tightening.