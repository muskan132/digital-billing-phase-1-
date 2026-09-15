# SCOPE v6 — Clean the base, then analytics, then surveys and ratings

Phase 6 **extends** v1–v5 and is the first phase that also **repairs**. It runs in four gated stages, in order, and a later stage does not begin until the one before it is verified:

**A · Clean the base** — every deferred defect, closed.
**B · Analytics** — merchant-facing charts on sale time.
**C · Surveys and ratings** — two merchant-managed modules, and the first unauthenticated write path in the system.
**D · Response analytics** — what C collects, charted.

Stage A exists because eight items have been correctly deferred for four consecutive phases, and that reasoning does not get weaker with repetition — but the list does get longer, and it is the whole gap between "five phases complete and verified" and "something a merchant could use." Stage C's new public attack surface is the specific reason A goes first.

## In scope

### Stage A — clean the base

1. **The callback `P2002` race.** Prisma's upsert with nested creates may not compile to a native `ON CONFLICT`, leaving a window on near-simultaneous `txnId` redelivery. Caught as a no-op, preserving D-8's idempotency guarantee.
2. **PII in Prisma's own thrown errors.** Application log lines are masked; Prisma's exception messages are not. A dedicated exception filter scrubs before Nest's default logger.
3. **Ops signal for permanently-failed broadcasts.** D-7's exhausted rows have been invisible to operators since v1. R-1 gave the *merchant* visibility; this gives the operator one. No new infrastructure.
4. **`pnpm verify`'s immutability blind spot.** The `Bill.layoutSnapshot` check only covers bills present in the committed baseline, so any bill created since the last `--write-baseline` has had zero protection, permanently.
5. **`TAX_COMPLIANT` renders in the wrong shell** — the generic 380px bill card instead of a document-width layout.
6. **`TAX_COMPLIANT`'s tax summary uses the forbidden pattern** — CGST/SGST as columns, the matrix `TEMPLATE_SYSTEM_v2` §5 explicitly forbids, instead of the one-row-per-component ladder.
7. **The missing invoice date.** `invoiceDate` extends `Bill.snapshot`'s D-17/D-28 whitelist. **Tier-1** — the whitelist is the PII boundary, and extending it carries D-17's full weight (D-88).
8. **Inter-state IGST visual verification.** Built and unit-tested in v2; never once viewed in a browser.

### Stage B — analytics

9. **A real sale time on the callback path.** `Order.saleAt` already exists and is already nullable, so no column is added: the work is parsing JioPay's `paymentDateTime` — a 14-digit `yyyyMMddHHmmss` string — into it, backfilling existing rows, and indexing `(merchantId, saleAt)`, since D-58's index is built on `createdAt`. Parsed as **IST** via one named constant, strictly, rejecting anything that is not 14 digits (D-83).
10. **Unparseable sale times are null and visible.** Such bills are excluded from every sale-time chart and surfaced as an explicit "unattributed" count, so a total never silently shrinks (D-84).
11. **Merchant analytics** — revenue over time split by `Order.source`, bill volume trends, average bill value, tax breakdown (CGST/SGST/IGST), and hour-of-day / day-of-week distribution. Money read from `Bill`, **every aggregate grouped by currency**, buckets computed in fixed IST (D-85).
12. **Bill-sent time, derived.** Computed from `Broadcast` as the first successful send per bill. Not stored, because R-2's resend means a bill can have several (D-86).

### Stage C — surveys and ratings

13. **Surveys as a merchant-managed entity** — created, edited and named by the merchant, independent of any template, then attached to a bill through a `SURVEY` block in the builder. Free text, ratings and multiple choice.
14. **Ratings as a separate module** — its own entity, editor, block, response storage and analytics, usable without a survey (D-91).
15. **Survey and rating definitions are snapshotted into `Bill.layoutSnapshot` at issue**, exactly as block props are frozen today. The renderer continues to read only the snapshot and never the database (D-89).
16. **Anonymity is chosen per survey at creation and is immutable.** An anonymous survey stores no link to the bill; de-duplication uses a one-way hash instead (D-90).
17. **One public, unauthenticated capture endpoint, shared by both modules** — the first unauthenticated write in this system. Keyed on the bill's unguessable link identifier, one response per bill per instrument, rate-limited, enumeration-resistant. **Tier-1** (D-92).

### Stage D — response analytics

18. **Survey analytics grouped by question version**, since a response answers the questions that were frozen onto *its* bill, not today's.
19. **Rating analytics** — distribution and trend, its own pipeline per D-91.

## Explicitly out of scope — deferred, **not designed**

- **The utility data model.** D-72 and D-73 made UTILITY uniformly "declared but not merchant-usable" from both Save As and create-from-scratch, and named the reversal: the phase that adds a real utility body block removes both refusals and unblocks the skeleton picker in one coherent change. That phase needs an input-contract extension, another D-28 whitelist extension, and a product ruling on whether a utility bill is a `TAX_INVOICE` or a third `BillType`. **Phase 7.**
- **A `Merchant.timezone` field.** Fixed IST is correct for every merchant today. The field is a migration that buys nothing until a non-Indian merchant exists, and D-85 confines the constant to one place so it is a contained change when one does.
- **Exporting survey or rating responses.** Free text is customer-written content, and an export of it is a new egress surface with its own D-70/D-71 questions. The audit machinery exists; the decision does not.
- **Moderation of free-text responses.** Stored as text, escaped at render, never interpreted as markup, length-capped. No review queue, no filtering (D-93).
- **Merchant user management.** Still structurally blocked on D-42's open sign-off — how a merchant user's `subject` gets provisioned. Unchanged.
- **Customer list.** Unchanged; D-48's reasoning still rejects it.
- **A login audit trail.** D-51's named gap. `PiiExportAudit` remains scoped to exports and must not quietly become a general audit log.
- **Retention and access policy for `PiiExportAudit`** — Compliance + Security, unchanged, blocking nothing.
- **Template usage analytics.** D-74 settled that lineage membership is a runtime walk with no stored key; per-lineage usage would need one. Not wanted.
- **Redis sessions, a BFF tier, JWT-to-BFF.** Unchanged.
- **Org sign-offs**, all unchanged and none resolvable in code: the direct-API auth model, GST invoice numbering, e-invoicing/IRN applicability, and D-22's tax-on-post-discount confirmation.

## The flow

```
STAGE A ── gate ──> STAGE B ── gate ──> STAGE C ── gate ──> STAGE D

Stage B · sale time
  JioPay callback -> paymentDateTime "yyyyMMddHHmmss" (raw string, kept forever)
        -> strict 14-digit parse, interpreted in IST_ZONE            (D-83)
             parses    -> Order.saleAt
             does not  -> Order.saleAt = NULL
  Direct API      -> Order.saleAt from sale_at (BR-6, unchanged)

  GET /portal/analytics?from&to
        -> aggregates over Bill, joined to Order for source/saleAt
        -> GROUP BY currency, always                                  (D-85)
        -> buckets computed in IST
        -> { series[], unattributedCount }                            (D-84)

Stage C · surveys and ratings
  /portal/surveys      CRUD -> Survey  (anonymity fixed at creation)  (D-90)
  /portal/ratings      CRUD -> Rating
        |
        +-- builder attaches SURVEY / RATING block, carrying the id
        |
  bill issued -> the definition is RESOLVED and FROZEN into
                 Bill.layoutSnapshot                                  (D-89)
        |
  public bill page -> renders from the snapshot only, never the DB
        |
  POST /r/:identifier/responses    (no auth, shared by both modules)  (D-92)
        unknown identifier            -> 404, same as the bill page
        already answered              -> 409, no write
        rate limit exceeded           -> 429
        attributable -> store billId
        anonymous    -> store dedupeHash only, never billId           (D-90)
```

## Definition of "done" (local UAT passes)

**Stage A.** Two simultaneous identical callbacks produce exactly one `Order`, one `Bill`, one `Link` — no `P2002` surfaces to the caller. A forced Prisma error carrying a customer mobile appears in no log line in any form. A permanently-failed broadcast emits an operator signal exactly once. `pnpm verify` fails when a bill created *after* the last baseline commit has its `layoutSnapshot` mutated — the case it could never catch before. `TAX_COMPLIANT` renders at document width with a component-ladder tax summary and no column matrix anywhere. A new `TAX_INVOICE` bill carries `invoiceDate` in `snapshot`, an existing one still does not, and the D-28 key-set test is updated to expect exactly one new field. An inter-state bill (`place_of_supply` 29 against merchant `27`) has been opened in a browser and IGST renders as one line, not as CGST/SGST.

**Stage B.** Every seeded PG order has a non-null `saleAt` after backfill, and its value equals the raw string reinterpreted in IST. A deliberately malformed `paymentDateTime` yields `saleAt = null`, is excluded from charts, and appears in the unattributed count. Re-running the backfill is idempotent and recomputes from the raw string, which is never modified. Every aggregate carries a currency; a second-currency bill produces a second group rather than a corrupted total. Revenue totals reconcile to `SELECT sum("totalPaise")` per currency. Hour-of-day buckets shift correctly for a bill at 23:30 IST. Bill-sent time is derived; a resent bill still reports its **first** successful send.

**Stage C.** A survey created, attached and issued renders on the public bill page; editing the survey afterwards leaves the issued bill **byte-identical** — proven against `layoutSnapshot`, not by eye. An anonymous survey's responses contain no `billId` anywhere in the table. A second submission against the same bill is `409` with zero writes. An unknown identifier is `404`, indistinguishable from the bill page's own behaviour. Rate limiting refuses the N+1th submission. A free-text response containing markup is stored verbatim and rendered inert. A rating works end to end with no survey present. A second merchant's survey and rating ids are `404` at every `/portal` route.

**Stage D.** Survey analytics group responses by the question version frozen on each response's bill — a survey edited mid-life produces two groups, not one merged average. Rating analytics reconcile to a direct `SELECT`.

**Throughout.** Every v1–v5 test green. No money path touched except Stage A's idempotency fix, which is verified against D-8's original guarantee. `Bill.snapshot` changes by exactly one field and `Bill.layoutSnapshot`'s existing rows are untouched. Every new `/portal` route returns `404`, never `403`, for a second merchant's resource.
