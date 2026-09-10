# SCOPE v5 — Template lifecycle, delivery visibility, export

Phase 5 **extends** v1/v2/v3/v4; it replaces nothing. The callback path, the direct API, the public bill page, the renderer, the broadcast queue, the portal session/CSRF machinery, and every `/demo` route keep working exactly as they do today. This phase turns the template surface from "one seeded default, forkable, archivable" into a real lifecycle a merchant can own — create, name, copy, delete, archive, restore, and choose a default per bill type — and adds the first two surfaces that let a merchant see and act on delivery: broadcast status and a resend, plus the first PII **export** path this system has ever had.

Three of this phase's items are direct collections on debts already recorded rather than new inventions. D-39's "per-`billType` defaults are a GAP, not built" is now blocking and is paid off here. D-48's "if export is ever built, it needs an audit table first, not after" is honoured literally: the audit table is a prerequisite task, not a follow-up. D-33's no-hard-delete rule gains its second written carve-out, structurally enforced the same way D-51's was.

Analytics and surveys are **Phase 6** and are not designed here.

## In scope

1. **Two default templates per merchant, one per `billType`** — `Merchant.defaultTemplateId` becomes `defaultReceiptTemplateId`, and `defaultTaxInvoiceTemplateId` joins it. This resolves D-39's recorded gap and is what makes item 2 possible at all (D-60).

2. **Direct-API template resolution becomes the contract it was always described as** — a caller-supplied `template_id` is resolved scoped to the caller's own templates plus the shared starters, exactly as today; an unknown or not-yours id falls back to **the merchant's chosen default for that bill type** and says so explicitly in the response; a real, visible template of the **wrong bill type** is a `422`, not a silent substitution. Supersedes D-13's "no per-order override in v1" and replaces the positional oldest-by-`createdAt` fallback chain (D-61).

3. **Save gains a name; Save As is a clean break** — `save()` accepts a `name` and renames in place within the lineage (still fork-on-write, D-32 untouched). Save As always produces a **new lineage** — `parentTemplateId: null`, `version: 1`, merchant-owned — whether the source is a starter or the merchant's own template, and records no link back to the source (D-62).

4. **Template names are unique per merchant among live head templates**, with automatic `(1)`, `(2)`, `(n)` suffixing server-side. Enforced by a partial unique index, not by application memory. Archive **reserves** a name; delete **frees** it (D-63).

5. **Create a template from scratch** — name, `billType` and `skeleton` chosen at creation, starting from a minimal document that already satisfies D-31's visible-block validation. `skeleton` is immutable after creation (D-66).

6. **Hard delete, as a structurally-enforced exception to D-33** — permitted only when **no bill references any version in the lineage**, in which case the entire lineage is removed. A template that has issued bills is **refused** with a named error offering archive instead. Neither current default may be deleted (D-64).

7. **Archive becomes a place, not a disappearance** — archived templates leave the main list and appear in a separate archived view, and can be **restored**. A restore whose name is taken is auto-suffixed to `(n)` (D-65).

8. **Starter templates are visually separated from the merchant's own** — the five seeded `merchantId: null` rows are presented as a distinct catalogue. This needs **no new column**: `merchantId IS NULL` already encodes it and is projected into the portal DTO as a flag (D-68).

9. **A UTILITY starter template, structurally complete and deliberately dataless** — a new `UTILITY` skeleton and renderer branch, plus `CONSUMER_INFO`, `BILLING_PERIOD`, `METER_READING`, `TARIFF_SLABS` and `DUE_DATE` declared in the shared manifest and renderer, rendering nothing until a data source exists. This is the `SAVINGS`/`LOYALTY` precedent applied deliberately. **No `Bill.snapshot` field is added and the D-17/D-28 whitelist is not extended by one field** (D-67).

10. **Delivery visibility** — broadcast status surfaced for the first time in any UI: per-merchant aggregate counts by status, and a list of failed deliveries. Fields are exactly D-48's already-decided set (`channel`, `status`, `attempts`, `sentAt`, masked `recipient`). No new PII boundary is created.

11. **Resend, failed-only** — a `FAILED` broadcast can be resent to its **stored recipient**, creating a **new** `Broadcast` row rather than mutating the old one. Refused while a `PENDING` broadcast already exists for that order. `MERCHANT_ADMIN` only (D-69).

12. **Bulk CSV export of bill history, with its audit table built first** — `PiiExportAudit` is a prerequisite task, and no export path ships before it. The audit row is written and committed **before** the export is produced (D-70). The merchant declares the contact projection per export — `masked` or `full`, no default, a missing value is `422` — and the audit row records which was produced. `MERCHANT_ADMIN` only; `STORE_STAFF` is refused both projections (D-71).

13. **A second seeded `STORE_STAFF` user**, closing D-50's named gap — the `STORE_STAFF` role paths have been written since A-3 and never once exercised by a real principal.

## Explicitly out of scope — deferred, **not designed**

- **All analytics.** Revenue over time, bill volume, average bill value, tax breakdown, and hour-of-day distribution are Phase 6. They need semantics decided first — which timestamp is "when" (`Order.createdAt` on the PG path is time of record, `Order.saleAt` on the direct path is store-local time of sale), what timezone a merchant is in (no such field exists), what counts as revenue when `amountPaise` is nullable by D-15, and how to sum across currencies. A dashboard number that is quietly wrong at day boundaries is worse than no dashboard.

- **Surveys, and therefore survey analytics.** `SURVEY` blocks are authored in the Retail and Restaurant starters today but nothing captures a response. Building this needs a public, unauthenticated write endpoint on the bill page — a new attack surface with its own spam and rate-limit questions — plus a response table. Phase 6, and its analytics are built with it, not after it.

- **Utility bill *data*.** Consumer number, billing period, meter readings, tariff slabs and due date have no source in either write path and no field in `Bill.snapshot`. Making them real requires extending the D-28 whitelist (carrying D-17's full Tier-1 weight, key-set test included) and extending the direct-API input contract, plus a product ruling on whether a utility bill is a `TAX_INVOICE` or a third bill type. The blocks ship declared and dataless; they light up with no template change when the data arrives.

- **Changing a template's `skeleton` after creation.** `save()` deliberately reconstructs `skeleton` from the parent and never trusts the client. Making it mutable means the render chrome of a live template can change under a merchant, and it has no bearing on anything else in this phase.

- **Merchant user management** (invite, remove, re-role, store assignment). Structurally blocked, not merely deprioritised: D-42's open sign-off explicitly includes *how a merchant user's `subject` gets provisioned in the first place*, and any invite flow has to answer that. The only unblocked variant — create a `User` with `subject: NULL` and bind on first login by matching the IdP's email claim — is a decision about trusting an email claim as an identity join, owned by Security + Platform. This phase seeds a second user and builds no UI (D-50, unchanged).

- **Customer list.** D-48's own reasoning rejects it: masking the bill list exists because "a merchant almost never needs 50 phone numbers at once." A customer list is precisely that surface, and it is a CRM feature wearing a billing feature's clothes.

- **Restoring a deleted template.** Delete is a hard delete of the whole lineage; there is nothing to restore. That is the price of freeing the name, and it is why delete is refused the moment a bill exists.

- **A login audit trail.** D-51 named this gap (session reaping loses "who logged in when"; `User.lastLoginAt` is a single overwritten timestamp). `PiiExportAudit` is deliberately scoped to exports only — it is not a general audit log and must not quietly become one.

- **Retention and access policy for `PiiExportAudit`.** The table is append-only by construction and by convention; how long rows are kept and who may read them is a compliance question with no owner yet. Recorded as unanswered rather than answered by default.

- **Demo-route parity.** The demo builder page has **no save handler at all** — only the portal builder can write. Per D-49, new merchant-facing functionality is built at `/portal` first and the demo route is not backfilled. The two will diverge further this phase; that is expected, not drift.

- **Redis sessions, a BFF tier, short-lived JWT-to-BFF** — unchanged from v4.

- Every pre-existing pre-production blocker is unchanged and this phase fixes none of them: the Prisma `P2002` race on the callback path, PII in Prisma-thrown errors, `TAX_COMPLIANT`'s two rendering bugs, the missing `invoiceDate`, and the unverified inter-state IGST render.

## The flow

```
/portal/templates                     (SessionGuard + MERCHANT_ADMIN on writes)
  GET  /portal/templates              -> { starters[], mine[], archived[],
                                           defaultReceiptTemplateId,
                                           defaultTaxInvoiceTemplateId }
                                         starter vs mine = merchantId IS NULL (D-68)
  |
  +-- POST /portal/templates              create from scratch
  |      name + billType + skeleton -> minimal D-31-valid document, version 1  (D-66)
  |
  +-- POST /portal/templates/:id/save     SAVE — fork in lineage (D-32, unchanged)
  |      optional name -> rename in place; name allocation applies       (D-62/D-63)
  |      parent isHead=false -> new row isHead=true -> default repointed if it pointed here
  |
  +-- POST /portal/templates/:id/save-as  SAVE AS — clean break            (D-62)
  |      { name, layoutSchema } -> NEW lineage: parentTemplateId=null, version=1,
  |      merchantId=session merchant. Source untouched. Default NOT repointed.
  |      Works from a starter AND from the merchant's own template.
  |
  +-- POST /portal/templates/:id/set-default   per billType               (D-60)
  |
  +-- POST /portal/templates/:id/archive       archivedAt=now, name STAYS reserved (D-65)
  +-- POST /portal/templates/:id/restore       archivedAt=null, name auto-suffixed (n)
  |
  +-- DELETE /portal/templates/:id             HARD delete, whole lineage  (D-64)
         any bill references any version?  --yes--> 422 TEMPLATE_HAS_ISSUED_BILLS
         is either current default?         --yes--> 422 CANNOT_DELETE_DEFAULT_TEMPLATE
         otherwise --> delete every row in the lineage; the name is freed

POST /v1/bills  (ApiKeyGuard, unchanged)                                   (D-61)
  template_id supplied?
    -> scoped lookup { id, OR:[{merchantId},{merchantId:null}] }
         not found ------------------> merchant's defaultTaxInvoiceTemplateId
                                       + response states the fallback and why
         found, billType mismatch ---> 422 TEMPLATE_BILL_TYPE_MISMATCH, no write
         found, billType matches ----> use it
  template_id absent
    -> merchant's defaultTaxInvoiceTemplateId

JioPay callback path (P-1, unchanged in shape)
  -> merchant's defaultReceiptTemplateId. No override exists; the webhook payload
     carries no template field and never will.

/portal/deliveries
  GET  /portal/deliveries              counts by status + failed list
                                       (channel, status, attempts, sentAt, masked recipient)
  POST /portal/bills/:id/resend        FAILED only, stored recipient only     (D-69)
         a PENDING broadcast already exists for this order? -> 422, no write
         otherwise -> INSERT Broadcast(status=PENDING, same recipient, attempts=0)

/portal/bills/export
  GET  /portal/bills/export.csv                                        (D-70)
         INSERT PiiExportAudit -> COMMIT -> then stream the file
```

## Definition of "done" (local UAT passes)

- **Defaults.** `Merchant` carries two pointers; the existing value has moved to `defaultReceiptTemplateId` with no row losing its default. The PG callback path resolves the receipt pointer, `POST /v1/bills` resolves the tax-invoice pointer, and `grep` finds no remaining reader of `defaultTemplateId`.
- **Resolution contract.** A `template_id` for another merchant's template falls back to the default and the response says so; an unknown id does the same; a real `RECEIPT` template id on `POST /v1/bills` returns `422` with **zero** rows written; the previous oldest-by-`createdAt` fallback chain appears nowhere in the code.
- **Names.** Two live head templates with the same name are impossible — proven by attempting it directly against the database, not only through the API. Save As of "Retail Bill" yields "Retail Bill (1)"; a third yields "(2)". Archiving "Retail Bill" and creating a new one yields "Retail Bill (1)" — the archived name is still reserved. Deleting "Retail Bill" and creating a new one yields "Retail Bill" with no suffix. A concurrent same-name save is resolved by the `P2002` retry, not by a crash.
- **Save vs Save As.** Save on a merchant template leaves **one** entry in the list, the parent `isHead=false`, and repoints whichever default pointed at the parent. Save As from the same template leaves **two** entries, the source completely unchanged (`isHead` still true, `layoutSchema` byte-identical), and repoints **nothing**. Save As from a starter produces a merchant-owned row with `parentTemplateId: null` and `version: 1`, and the starter row is byte-identical afterwards.
- **Starters stay immutable.** `save()` against a `merchantId: null` row still returns `CANNOT_FORK_LIBRARY_PRESET`; delete and archive against one return `404`; a second merchant sees the same five starters unchanged after the first merchant's entire session.
- **Create from scratch.** A template created with name + `billType` + `skeleton` validates on first save with no edits — the starting document already satisfies D-31. No route accepts a `skeleton` change on an existing template.
- **Delete.** A template with no bills in its lineage is deleted along with **every** version row, and `SELECT count(*)` on `Bill` is unchanged. A template with one bill anywhere in its lineage returns `422 TEMPLATE_HAS_ISSUED_BILLS` and **zero** rows are removed. Either current default returns `422`. A second merchant's `templateId` returns `404`.
- **Archive and restore.** An archived template is absent from the main list, present in the archived view, and its name is still refused to a new template. Restore returns it to the main list; restoring into a taken name yields `(n)`.
- **Utility.** The `UTILITY` starter renders end-to-end through the production renderer at all three preview widths. The five new blocks are present in the shared manifest, are accepted by `validateLayoutSchema`, and render **nothing** — asserted by a test, so "dataless" is a property and not a comment. `Bill.snapshot` is byte-identical to before this phase for every existing bill and the D-17/D-28 key-set test is unchanged.
- **Delivery.** Aggregate counts reconcile to `SELECT status, count(*)`. The failed list shows masked recipients only — a key-set test fails if a raw recipient appears. Contact never appears in a log line (deny-test).
- **Resend.** Resending a `FAILED` broadcast creates exactly **one** new row, leaves the original row untouched including its `attempts`, and the drainer picks it up. A second resend while the first is `PENDING` is refused with zero writes. Resend on a `SENT` broadcast is refused. A `STORE_STAFF` principal gets `403`. Another merchant's `billId` gets `404`.
- **Export.** No export response is produced without a committed `PiiExportAudit` row — proven by killing the export after the audit write and observing the orphan audit row, which is the safe direction. The audit row records merchant, user, timestamp, row count, the filters used, and which contact projection was produced. A request with no `contact` parameter returns `422` with **no** audit row and **no** file. A `masked` export contains no raw contact anywhere — key-set test at the serializer; a `full` export contains exactly D-48's detail field set and nothing outside it. `STORE_STAFF` receives `403` for both projections and writes no audit row. Cross-merchant export contains only the session merchant's rows, cross-checked against `SELECT count(*)`.
- **Roles.** With a second seeded `STORE_STAFF` user, every builder write route returns `403` and every read route returns `200` — D-50's gap closed by a real principal, not by a mocked reflector.
- **Tenancy.** Every new `/portal` route asked for a second merchant's resource while authenticated as the first returns `404`, never `403`, with zero writes.
- **Immutability.** Create a bill, then make three portal builder edits, a Save As, a rename, an archive and a restore against its template — the re-resolved bill's rendered block list is **unchanged**. `Bill.layoutSnapshot` and the public bill page are untouched by every operation in this phase.
- **Every v1, v2, v3 and v4 test still green.** No money path touched. No change to the renderer's existing skeletons or the public bill page.
