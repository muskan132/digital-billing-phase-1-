# Digital Billing — Session Handoff (Post-Demo)

> This captures not just *what* was decided but *why* — the reasoning that doesn't survive in a terse memory bullet. Read this before Phase 3 planning starts.

---

## 1. What exists today

**Phase 1** — payment callback → receipt → link → PDF/share → email. **Phase 2** — merchant direct API → GST-validated tax invoice. Three templates (TAX_COMPLIANT, RETAIL, RESTAURANT). A demo control panel with a live-fillable form. A QR code on RETAIL. All roadmap tasks audited and closed; both phases CTO-reviewed; demo delivered successfully.

---

## 2. The reasoning worth keeping — decisions and *why*

**Direct API creates an `Order`, not a new root (Option A).** The tempting "clean" design was making `Bill` the root entity, since a direct-API invoice isn't really a "payment order." Rejected because Phase 1's hardest-won correctness — replay-safe nested writes, the PII whitelist boundary, the broadcast queue — all lives in code paths keyed on `Order`. Reparenting would re-open all of it for semantic tidiness alone. **General lesson: don't refactor working, verified infrastructure for elegance when the same outcome is achievable by extension.**

**The system validates tax, never originates it.** Merchant supplies figures; the server independently recomputes from line items and rejects on any mismatch, to the paisa. This isn't just a technical choice — it's a liability allocation. Whoever issues a tax invoice is legally responsible for its correctness under GST law, and that's the merchant, not the platform. Building a "smart" system that *calculates* tax for merchants would mean owning that liability. **This is the answer to give if anyone asks "why doesn't the system just compute tax for us."**

**Bills freeze their render spec at creation (`Bill.layoutSnapshot`).** Discovered as a *live bug*, not a hypothetical: the renderer originally read a template through a live join, so editing a template retroactively changed every bill ever issued against it — a defective compliance document. The fix: copy the full resolved render spec onto the bill at creation; the renderer reads only that, never the live template again.

A tempting alternative was considered and rejected: **lock a template once any bill uses it, fork a new row on edit.** This looks equivalent but isn't — "locked" is a rule that has to be *enforced* by every future write path (including tools that don't exist yet, like an admin script), and one missed enforcement point silently breaks the guarantee. The snapshot needs no enforcement at all: bills simply stop reading templates at render time, so there's nothing to forget. **General lesson: prefer "make the invalid state unrepresentable" over "add a rule someone has to remember to check."** Fork-on-write was kept as a *future* feature — it gives merchants git-like template version history, which is genuinely valuable — but explicitly demoted from being the correctness mechanism.

**Money is masked at the writer, never trusted at the reader.** This pattern recurred three times independently: PII masking only covers your own log lines, not what a third-party library (Prisma, nodemailer) embeds in its own thrown errors. Each time, the fix was catching and sanitizing *at the boundary where the untrusted content enters*, not downstream. **This is a checklist item for any future third-party integration: assume every library-thrown error can leak something, until proven otherwise.**

**The demo-endpoint security design chose 404-over-403 deliberately.** A request hitting the demo-only routes in production gets a 404, not a 403 — so an attacker probing the production API can't even confirm the route exists. This is a stronger default than "gate it and return unauthorized," worth carrying into any future dev/demo-only surface.

**Templates are stored as two layers: a code manifest (what a block type *is*) and JSON instance data (what a merchant *configured*).** This is the standard pattern behind every mature block-based builder (WordPress, Shopify, Filament) and it's what makes the future drag-and-drop builder possible without a rewrite. The critical sub-decision inside this: every table column separates `field` (immutable data binding) from `label` (merchant-editable display text) — this is what lets a merchant rename "AMOUNT" to "Total" without ever being able to accidentally rebind that column to the wrong number.

**The tax display was rebuilt from real reference bills, not invented.** Several rounds of guessing at "how should GST breakdown look" produced structures that didn't match how real Indian bills present tax (a per-rate-per-component matrix table). The actual answer, derived from real Decathlon/MEX Burgers receipts: **aggregate CGST and SGST into one line each across the whole bill, regardless of how many different tax rates are on it** — no per-rate breakdown shown to the customer at all. **Lesson for any future visual work: get a real reference image before building, not after three failed rounds of guessing.**

**Layout model deliberately rejects free-form canvas positioning for the future builder.** Fixed x/y coordinates break on a bill with a variable number of line items and variable screen widths. The design instead uses a vertical stack with row-grouping and fractional widths — genuine drag-and-drop feel, but structurally guarantees no merchant-built layout can ever produce a broken bill.

---

## 3. Complete pending-work inventory

### Real bugs, tracked, not yet fixed
1. **Prisma `P2002` race** on near-simultaneous duplicate requests — self-heals via retry, fine for local/demo, needs a proper catch-as-no-op fix before production traffic.
2. **PII leaking through Prisma's own thrown error messages** (not app log lines, which are correctly masked) — needs a dedicated exception filter before anything leaves local.
3. **`TAX_COMPLIANT`'s two known issues**: still renders in the generic receipt-card shell (never got the wide document layout it was planned for), and still uses the old `legacy_matrix` tax display instead of the corrected aggregated pattern RETAIL/RESTAURANT now use.
4. **No invoice date field** anywhere in `Bill.snapshot` for direct-API-created invoices.
5. **Pending live verification** (built + unit-tested, never manually confirmed): RETAIL's inter-state IGST case — create a bill with `place_of_supply` ≠ merchant's `gstStateCode`, confirm a single aggregated IGST row renders instead of CGST/SGST.

### Deferred by design — real future features
6. **Merchant template UI builder** — the strategic direction of the whole product. Three-stage workflow: Components tab (edit individual components, rename labels, choose visible columns/order) → Bill tab (drag-and-drop assembly, resize) → Final look. Storage already designed to support this (block manifest in code, instance JSON with `field`/`label` separation, fork-on-write versioning for template history).
7. **Merchant-customizable QR code** — two modes: scannable-bill/ticket (Cinepolis-style, the QR *is* the ticket) or custom content (merchant picks the destination). Current QR is a static engagement placeholder only.
8. **Merchant variable aliasing** — canonical variable names with per-merchant display labels, potentially both outbound (bill display) and inbound (API field names) — open question on inbound scope.
9. **B2B invoicing with buyer details** — needs its own authenticated path; the current bill page is public and unauthenticated, so buyer PII cannot go there.
10. **Utility/consumer bill template** — blocked on an entirely new data model (meter readings, tariffs, billing periods, consumer numbers) that doesn't exist anywhere yet.
11. **Real delivery channels** — swap local email/SMS stubs for actual providers.
12. **Merchant self-service portal** — auth, per-merchant defaults, bill history.
13. **Server-side PDF generation** — current PDF is browser-native print, can't be attached to emails.

### Decisions deferred to your organization, not yet made
14. **Auth model** for the merchant API — demo uses a simple API key; real choice (API key / OAuth / mTLS) needs Security + Platform.
15. **GST invoice numbering ownership** — demo has the caller supply it; whether the core should own a gap-free sequential series needs Product + Compliance.
16. **E-invoicing/IRN mandate applicability** — unverified whether any merchants cross India's e-invoicing threshold; if yes, this becomes a much larger integration project. Ask compliance early.
17. **Tax-on-post-discount-value assumption** (D-22) — standard reading of GST law, pending compliance confirmation.

---

## 4. What this means for Phase 3 planning

Fourteen real items across three categories: **bugs to fix**, **features to build**, **decisions to get from your org**. That's too much to sequence blind — before I draft a roadmap, I need your priorities.
