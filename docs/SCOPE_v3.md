# SCOPE v3 — Merchant template UI builder

Phase 3 **extends** v1/v2; it replaces nothing. The callback path, the direct API, the link, the broadcast queue, and every already-issued bill are untouched. This adds the merchant-facing surface that writes `Template.layoutSchema` — the thing Phases 1–2 have been shaping the storage model for.

Architecture is **already decided** in `TEMPLATE_SYSTEM_v2.md` (§1 two-layer storage, §2 the v2 `layoutSchema` shape, §3 the 22-block catalogue, §6 the vertical-stack-with-row-grouping layout model, §7 immutability + fork-on-write, §8 validation rules, §9 the builder-capability map). This document does not re-derive any of it; it scopes the build and records the five decisions §10 left open.

## In scope

1. **COMPONENTS tab** — edit one block in isolation: its manifest-declared props, rename any `label`, toggle `visible`, reorder columns, set `align`. Uses the `field`/`label` separation from §2 verbatim: `field` is never editable.
2. **BILL tab** — assembly: add from the palette, remove, hide, reorder (`blocks[].order`), set `width` (`full`/`half`/`third`), group adjacent blocks into a row per §6. **No x/y positioning, no pixel sizing.**
3. **FINAL LOOK** — live preview through the *same* renderer that produces customer bills (§9's last row: "preview *is* production"), proven by a parity test, not by inspection.
4. **`layoutSchema` v2 made real** — `schemaVersion`, `skeleton`, `theme`, `blocks[].id/visible/width`. Additive; existing templates migrate, existing bills do not (see D-29).
5. **Fork-on-write versioning** — every save creates a new `Template` row with `parentTemplateId`; nothing is mutated in place (§7, D-32).
6. **Template CRUD scoped to the single seeded demo merchant** — list, open, clone-from-library, save (fork), set default, archive. Demo-gated, 404-over-403 in production per the demo-endpoint precedent.
7. **Client-side validation that mirrors the server's rules exactly** — one shared validator, surfaced before Save is reachable (FSD 6.2 validations; `frontend-design.md`: "the client mirrors, it never replaces, server enforcement").

## Explicitly out of scope — deferred, **not designed**

- **Real merchant login / multi-tenant auth.** The builder targets the one seeded merchant, same as v1/v2. **Deliberate:** real auth pulls in the entire merchant-portal project (OIDC, sessions, per-merchant scoping on every read) as a prerequisite. D-38.
- **Engagement block data.** `COUPON` / `SURVEY` / `MARKETING` remain template-authored static props. No campaign data model, no widget-data-completeness enforcement (FSD 5.10 / BR-14 stays unbuilt).
- **Customizable QR content modes** (scannable-ticket vs merchant destination).
- **Inbound API field aliasing.** Only outbound display labels — already designed in §2 and explicitly one-directional there.
- **B2B invoicing / `BILL_TO`** — needs the separate authenticated path (§4.4).
- **Utility templates / `CHARGES` / `METER_READING`** — blocked on an upstream data model that does not exist.
- **Server-side PDF.**
- Template *version-history browsing UI*. Lineage is recorded by D-32; a UI to walk it is not in this phase.
- Branding upload (logo, colour pickers, fonts — FSD 6.3). `theme` is stored and honoured; the editor for it is not built beyond an accent value.

## The flow

```
/demo/templates  (demo-gated, seeded merchant)
  -> clone a library preset (deep copy, D-33)  OR  open my head template
  -> COMPONENTS tab: edit props / labels / column visibility+order
  -> BILL tab:       add · remove · hide · reorder · width fraction · row grouping
  -> FINAL LOOK:     iframe preview, shared renderer, synthetic fixture data (D-34/D-35)
       |
       +-- validateLayoutSchema(draft) runs on EVERY mutation; blocking issues
           name the offending block and hold Save disabled (D-31, D-30)
       |
  -> Save --ONE transaction--> new Template row (parentTemplateId=old, version+1,
                               isHead=true), old row isHead=false,
                               Merchant.defaultTemplateId repointed if it pointed
                               at the old row                                (D-32)
       |
       +-- next bill from EITHER write path resolves the new head and freezes it
           into Bill.layoutSnapshot; every already-issued bill is unaffected (§7)
```

## Definition of "done" (local UAT passes)

- Clone a library preset → a merchant-owned `Template` row exists with `parentTemplateId` = the preset and a **deep-copied** `layoutSchema` (mutating the clone leaves the preset byte-identical).
- Rename the `ITEMS` `AMOUNT` column to `Total`, hide `HSN`, reorder two columns → preview updates; saved `layoutSchema` shows the changed `label`/`visible`/order and an **unchanged `field`** on every column.
- Drag a block to a new position and set two adjacent blocks to `half` → they render side-by-side at desktop width and stack at 380px, in both the preview **and** the real bill page.
- **Preview parity:** the parity test renders the same `(layoutSchema, fixture)` through the builder's preview path and the production bill renderer and asserts **identical HTML**.
- Save → **exactly one** new `Template` row; the parent row still exists with `isHead=false`; `version` incremented; `Merchant.defaultTemplateId` points at the new row; **no `UPDATE` touched the parent's `layoutSchema`**.
- **Immutability regression (§7's named test) still green:** create a bill, save three template edits, re-resolve the bill → rendered block list unchanged.
- Delete the `HEADER` block, or hide it → Save is **disabled**, the issue is listed by name, and clicking the issue focuses the block. Force the same document at the API → `422`, nothing written.
- A `layoutSchema` carrying an unknown block type cannot be produced by the UI and is rejected at the write boundary; a v1-shaped `Bill.layoutSnapshot` from a Phase-1/2 bill still renders.
- Archiving the current default is refused; archiving any other template succeeds and it disappears from the list while its bills still render.
- `/demo/templates` returns **404** when the demo gate is off.
- Every v1 and v2 test still green. No money path touched. No PII enters the builder: preview data is synthetic (D-35).

## GAPS & RISKS

1. **`apps/web` ↔ Prisma reach is unverified.** D-30's physical home for the manifest+validator depends on whether `apps/web` already queries Postgres directly (as L-2/V-2 suggest) or goes through `apps/api`. T-3 must confirm before writing code. If it goes through `apps/api`, the shared module must be a workspace package — duplication with a drift test is rejected (D-30).
2. **`@dnd-kit` is a new runtime dependency** and the first UI library in the project (D-36). Its version/maintenance status is a volatile fact and must be checked at install time, not taken from this doc. Mitigation is structural: it touches no persisted shape.
3. **Merchant-authored strings widen the public XSS surface.** Every `label`, `heading`, and `CUSTOM_CONTENT` string a merchant types lands on an unauthenticated public page. §3's rule (plain JSX children, never `dangerouslySetInnerHTML`) now has a real author behind it, not a seeded fixture. Needs an explicit test with `<script>` in a label.
4. **No length or count caps decided.** Nothing yet bounds label length, block count, or `CUSTOM_CONTENT` size. A 50KB label is currently storable and renderable. Caps needed before any non-local deployment; not specified by FSD or TDS.
5. **`theme.accentHex` is merchant-controlled colour on a compliance document.** A merchant can set unreadable contrast. Accepted for demo; no contrast validation built.
6. **Branding still drifts on old bills** — §7 already records this: `Merchant` branding is not snapshotted, so it retroactively affects issued bills. Unchanged by this phase, restated because the builder makes branding feel editable.
7. **`Bill.layoutSnapshot` is still nullable** and pre-snapshot bills may exist in dev data. The v1→v2 read normalizer must tolerate `null` and fall back exactly as today.
8. **Fixture drift.** Synthetic preview fixtures (D-35) can fall behind the real snapshot shape as `Bill.snapshot` evolves. A type-level tie to the D-28 key-set is required, or the preview silently starts lying.
9. **Open question §11.3 (nesting depth) is answered by omission** — one level (row grouping) only. Recorded so it is a decision, not a gap.
10. **Open question §11.4 (merchant-level label defaults) remains open.** Labels are per-block, per-template only in this phase. A merchant with three templates renames "ITEM" three times.
11. **Every pre-existing pre-production blocker is unchanged** and this phase adds none of the fixes: the Prisma `P2002` race, PII in Prisma-thrown errors, `TAX_COMPLIANT`'s two rendering bugs, the missing `invoiceDate`, and the unverified inter-state IGST render. The builder does not touch them; it also does not excuse them.
