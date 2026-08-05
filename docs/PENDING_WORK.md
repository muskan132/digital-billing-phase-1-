# Digital Billing — Pending Work Backlog

> Everything left open after Phase 1 + Phase 2. Organized by category, not priority — see `SESSION_HANDOFF.md` for the reasoning behind any item marked with a decision reference.

---

## A. Bugs — real defects, not fixed yet

| # | Item | Severity | Notes |
|---|---|---|---|
| A1 | Prisma `P2002` race on near-simultaneous duplicate requests | Pre-production blocker | Self-heals via retry today; needs a proper catch-and-no-op fix before real traffic |
| A2 | PII can leak via Prisma's own thrown error messages | Pre-production blocker | App log lines are correctly masked; the framework's own errors are not — needs a dedicated exception filter |
| A3 | `TAX_COMPLIANT` still renders in the generic receipt-card shell | Visible, not fixed | The wide document layout was planned, approved-in-principle, never built |
| A4 | `TAX_COMPLIANT`'s tax display uses the old `legacy_matrix` pattern | Visible, not fixed | RETAIL/RESTAURANT already have the corrected aggregated CGST/SGST display; TAX_COMPLIANT wasn't migrated (deliberately, to avoid touching shipped code as a side effect of an unrelated task) |
| A5 | No invoice date field anywhere in `Bill.snapshot` | Data gap | Affects direct-API-created invoices; needs a P-2 persistence change, not just a rendering fix |
| A6 | RETAIL's inter-state IGST case — unit-tested, never manually verified | Verification gap | Create a bill with `place_of_supply` ≠ merchant's `gstStateCode`, confirm a single IGST row renders |

## B. Features — deferred by design, real future scope

| # | Item | Depends on |
|---|---|---|
| B1 | **Merchant template UI builder** (Components → Bill → Final look) | Nothing — storage already designed for this. **Currently being scoped as Phase 3.** |
| B2 | Customizable QR — scannable-bill/ticket mode or custom-content mode, merchant-chosen | B1 conceptually (similar builder-style config), not strictly blocked by it |
| B3 | Merchant variable aliasing — canonical field → per-merchant display label | Outbound labels are effectively covered by B1's field/label model; inbound API field aliasing is a separate open question |
| B4 | B2B invoicing with buyer details | A new authenticated path (current bill page is public/unauthenticated — buyer PII can't go there) |
| B5 | Utility/consumer bill template (electricity, etc.) | An entirely new data model — meter readings, tariffs, billing periods, consumer numbers. Nothing upstream produces this today |
| B6 | Real delivery channels (replace email/SMS stubs) | A chosen vendor — currently just a swappable adapter with no real provider behind it |
| B7 | Merchant self-service portal (auth, defaults, bill history) | An auth model decision (see C1) |
| B8 | Server-side PDF generation (+ email attachment) | A PDF library decision; current PDF is browser-native print only |
| B9 | Engagement block real data (COUPON/SURVEY/MARKETING) | Currently template-authored static placeholder content, not real per-campaign merchant data |

## C. Decisions needed from your organization — not yet answered

| # | Item | Who owns it | Current stopgap |
|---|---|---|---|
| C1 | Auth model for the merchant API (API key / OAuth / mTLS) | Security + Platform | Simple per-merchant API key |
| C2 | GST invoice numbering — caller-supplied or core-generated sequence | Product + Compliance | Caller supplies it (additive-safe default) |
| C3 | E-invoicing/IRN threshold applicability | Compliance | Unverified — ask early, thresholds change often |
| C4 | Tax-on-post-discount-value assumption (D-22) | Compliance | Standard reading of GST law, applied as-is, pending confirmation |

---

## What's actively being worked

**Phase 3 — the template UI builder (B1)** is the current priority, being scoped now against `docs/TEMPLATE_SYSTEM_v2.md`'s already-designed architecture.

Everything else in this backlog is parked, tracked, and will surface automatically in future sessions via memory — nothing here needs to be re-explained when it comes up.
