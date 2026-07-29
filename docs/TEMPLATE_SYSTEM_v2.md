# Template System — Digital Billing

> **What this is.** The four default bill templates, the complete block catalogue behind them, and how templates are stored so that today's defaults become tomorrow's merchant-editable templates without a rewrite.
>
> **Governing constraint.** Every decision here is made against a future merchant UI builder (Components tab → Bill tab → Final look). Nothing may be stored in a shape that a builder cannot later read, write, and round-trip.

---

## 1. Storage model — the two-layer split

This is the single most important decision. Every mature block builder (WordPress Gutenberg, Shopify theme blocks, Drupal Layout Builder, Filament) converges on the same split, and it is what makes a builder possible:

| Layer | Lives in | Holds | Who edits |
|---|---|---|---|
| **Block manifest** | Code (`block-manifest.ts`) | What a block type *is* — its allowed props, defaults, which data fields it can bind to, which renderer draws it | Engineers, at deploy time |
| **Block instance** | DB (`Template.layoutSchema` JSONB) | What *this* merchant configured — chosen blocks, order, renamed labels, visible columns | Merchants, at runtime |

**Why the manifest must be code, not DB:** a block type is only real if a renderer knows how to draw it. A row in a table declaring a `COUPON` block with no `COUPON` renderer is a broken bill. Binding the manifest to code keeps the two in lockstep and gives compile-time exhaustiveness checking (the discriminated-union pattern already in `template-renderer.ts` — no `default` case, so TypeScript refuses to compile if a block type has no renderer).

**Why instances must be JSON, not normalised tables:** blocks have heterogeneous props (a `COUPON` has a code and expiry; an `ITEMS` block has a column array). Normalising that means either an EAV table or one table per block type — both are worse than a validated JSON document. The validation lives at the write boundary, not in the column type.

---

## 2. `layoutSchema` — target shape (v2)

```json
{
  "schemaVersion": 2,
  "skeleton": "RETAIL",
  "theme": {
    "accentHex": "#df9f3a",
    "density": "comfortable"
  },
  "blocks": [
    {
      "id": "blk_h7x2",
      "type": "ITEMS",
      "order": 4,
      "visible": true,
      "width": "full",
      "props": {
        "heading": "Items",
        "columns": [
          { "field": "name",          "label": "ITEM",   "visible": true,  "align": "left"   },
          { "field": "quantity",      "label": "QTY",    "visible": true,  "align": "center" },
          { "field": "unitPricePaise","label": "RATE",   "visible": true,  "align": "right"  },
          { "field": "amountPaise",   "label": "AMOUNT", "visible": true,  "align": "right"  },
          { "field": "hsn",           "label": "HSN",    "visible": false, "align": "left"   }
        ],
        "secondaryFields": ["hsn"]
      }
    }
  ]
}
```

### Why each field exists — all are builder-load-bearing

- **`schemaVersion`** — lets the renderer handle older stored templates when the block model evolves. Without it, any schema change means migrating every stored template at once or breaking them. Non-negotiable before merchants own templates.
- **`skeleton`** — the visual treatment (typography, density, framing). Same blocks + different skeleton = different look. Already proven: MINIMALIST and COMPACT_THERMAL render identical blocks completely differently.
- **`theme`** — per-template overrides for accent colour and density. Keeps branding out of block props so it can't drift block-to-block.
- **`blocks[].id`** — **stable per-block identity.** The builder needs this for drag handles, undo/redo, and per-block editing. Array position is *not* identity: reordering must not look like delete-then-create.
- **`blocks[].type`** — closed enum, validated at write. The security boundary: unknown type rejected at save, skipped at render (defence in depth).
- **`blocks[].order`** — explicit ordering, independent of array position. Makes a drag-reorder a single-field update per block.
- **`blocks[].visible`** — hide without deleting. Deleting a block loses its configured props; the builder needs non-destructive toggling.
- **`blocks[].width`** — `"full" | "half" | "third"`. Enables side-by-side rows (see §6) without free-form positioning.
- **`blocks[].props`** — per-type config, schema-validated *against that type's manifest entry*.

### The column model — this is the crux

```json
{ "field": "unitPricePaise", "label": "RATE", "visible": true, "align": "right" }
```

Three distinct concerns, deliberately separated:

- **`field`** — the **canonical data binding**. System-owned, immutable, never merchant-editable. This is the contract with the renderer and the data layer.
- **`label`** — the **display text**. Fully merchant-editable. Rename `ITEM` → `Product`, `AMOUNT` → `Total`, whatever they want.
- **`visible` / order / `align`** — presentation, merchant-controlled.

**This separation is what makes renaming safe.** The merchant changes what the customer *sees*; the system keeps its grip on what the value *is*. A merchant renaming `AMOUNT` to `Total` can never accidentally rebind that column to a different number. It also directly delivers the Components-tab requirement: rename headings, choose which variables to show, choose their order.

**Note:** this is display-side only. It does **not** rename inbound API field names. Keeping the aliasing one-directional avoids per-merchant request schemas, which would make validation and error handling substantially harder for very little gain.

---

## 3. Block catalogue

Twenty-two types cover all four templates. Marked ● = used, ○ = optional.

| # | Block | Purpose | Restaurant | Retail | Utility | B2B | Key props |
|---|---|---|---|---|---|---|---|
| 1 | `HEADER` | Merchant name/logo, doc label, status badge | ● | ● | ● | ● | `docLabel`, `showLogo`, `showStatus` |
| 2 | `MERCHANT_INFO` | Address, GSTIN | ● | ● | ● | ● | `showGstin`, `showAddress` |
| 3 | `BILL_META` | Bill no., date, industry meta | ● | ● | ● | ● | `fields[]` (same field/label model) |
| 4 | `ITEMS` | Line-item table | ● | ● | — | ● | `heading`, `columns[]`, `secondaryFields[]` |
| 5 | `CHARGES` | Tariff/service charges (replaces ITEMS) | — | — | ● | — | `heading`, `columns[]` |
| 6 | `TOTAL` | Pre-tax total | ● | ● | ● | ● | `label`, `showItemCount` |
| 7 | `TAX_SUMMARY` | Tax component ladder (§5) | ● | ● | ● | ● | `heading`, `mode`, `showTaxableColumn` |
| 8 | `AMOUNT_PAYABLE` | Hero total | ● | ● | ● | ● | `label` |
| 9 | `FOOTER` | Support contact, powered-by | ● | ● | ● | ● | `showSupport`, `customText` |
| 10 | `SAVINGS` | "You saved ₹X" callout | ○ | ● | — | — | `label`, `style` |
| 11 | `LOYALTY` | Points earned / balance | — | ● | — | — | `label`, `showBalance` |
| 12 | `PAYMENT_DETAILS` | Payment mode, or bank details | ● | ● | — | ● | `mode`, `fields[]` |
| 13 | `CONSUMER_INFO` | Consumer no., connection type | — | — | ● | — | `fields[]` |
| 14 | `METER_READING` | Previous / current / units | — | — | ● | — | `labels[]`, `highlightField` |
| 15 | `DUE_DATE` | Due date + late surcharge | — | — | ● | ● | `label`, `showSurcharge` |
| 16 | `PAY_NOW` | Payment CTA | — | — | ● | ○ | `label`, `url` |
| 17 | `USAGE_COMPARISON` | vs previous period | — | — | ● | — | `label`, `periodLabel` |
| 18 | `BILL_TO` | Buyer name/address/GSTIN | — | — | — | ● | `showGstin` |
| 19 | `COUPON` | Offer code + validity | ● | ● | ● | ● | `headline`, `code`, `validity`, `ctaLabel` |
| 20 | `SURVEY` | Rating / feedback prompt | ● | ● | ● | ● | `prompt`, `type`, `url` |
| 21 | `MARKETING` | Promo banner | ● | ● | ● | ○ | `headline`, `body`, `imageUrl`, `url` |
| 22 | `CUSTOM_CONTENT` | Free merchant text | ○ | ○ | ○ | ○ | `text` (output-encoded, never raw HTML) |

**Blocks 1–9 are the universal spine.** Every bill has them in that order. Everything else slots around it. This is why one renderer serves four industries.

**Security note on 19–22:** every merchant-supplied string in these props is untrusted. Render via plain JSX children only — never `dangerouslySetInnerHTML`. `CUSTOM_CONTENT` in particular must never accept HTML.

---

## 4. The four default templates

Presets, in Shopify's sense: pre-built block configurations a merchant selects and then customises. Stored as library templates (`merchantId = NULL`), cloned on edit.

### 4.1 Restaurant / QSR
`HEADER · MERCHANT_INFO · BILL_META · ITEMS · TOTAL · TAX_SUMMARY · AMOUNT_PAYABLE · FOOTER · COUPON · SURVEY`
- `ITEMS` columns: name + amount only. Quantity inline with the name (`Paneer Tikka × 1`). HSN hidden — a diner doesn't need it.
- `BILL_META`: bill no., date, order type. **No table number or server name** — internal tracking, not customer-useful.
- Single tax slab typical → `TAX_SUMMARY` in `simple` mode.

### 4.2 Retail
`HEADER · MERCHANT_INFO · BILL_META · ITEMS · TOTAL · SAVINGS · TAX_SUMMARY · AMOUNT_PAYABLE · PAYMENT_DETAILS · FOOTER · LOYALTY · COUPON`
- `ITEMS` columns: name, qty, rate, amount. HSN as a secondary line under the item.
- Multiple tax slabs typical → `TAX_SUMMARY` in `detailed` mode.
- `SAVINGS` sits between total and tax — the Reliance pattern.

### 4.3 Utility / Public sector
`HEADER · CONSUMER_INFO · METER_READING · CHARGES · TOTAL · TAX_SUMMARY · AMOUNT_PAYABLE · DUE_DATE · PAY_NOW · FOOTER · USAGE_COMPARISON · MARKETING · SURVEY`
- No `ITEMS` at all — `CHARGES` replaces it (energy charges, fixed charges, arrears).
- **Electricity supply is GST-exempt in India.** `TAX_SUMMARY` renders a state Electricity Duty row instead of CGST/SGST, with an explanatory note. This is a genuine industry difference in *tax treatment*, not just layout.
- `DUE_DATE` is the second-loudest element after the amount.

### 4.4 B2B Tax Invoice
`HEADER · MERCHANT_INFO · BILL_TO · BILL_META · ITEMS · TOTAL · TAX_SUMMARY · AMOUNT_PAYABLE · PAYMENT_DETAILS · FOOTER · COUPON · SURVEY`
- Document proportions (~700px), not phone-card width. Nobody opens this on a phone.
- `BILL_TO` is legally required and is **the reason B2B needs its own path** — the current bill page is public and unauthenticated, so buyer details must not render there.
- `PAYMENT_DETAILS` in `bank` mode: bank, A/C, IFSC, terms.
- `COUPON` translates to an early-payment discount.

---

## 5. Tax ladder rules

Derived from real bills (Decathlon, MEX Burgers). **Each tax component is its own row.** Never a rate-matrix with CGST/SGST as columns — no real bill does that.

### Component rates are derived, not stored
- **Intra-state** (`placeOfSupply == merchant.gstStateCode`): each slab yields two rows — `CGST` and `SGST`, each at **half** the item rate. An 18% item shows `CGST 9%` + `SGST 9%`.
- **Inter-state**: one row per slab — `IGST` at the **full** rate.

Data stores `taxRateBp` (e.g. `1800`) and the already-split `cgstPaise`/`sgstPaise`. The component rate is **presentation-layer arithmetic**: `taxRateBp / 2` for intra-state. Integer division on basis points — no floats, no new stored field.

### Two render modes
- **`simple`** (single slab): vertical label/value ladder — `Taxable Amount`, `CGST 2.5%`, `SGST 2.5%`, `Total Tax`. No rate column needed.
- **`detailed`** (multiple slabs): four columns — `COMPONENT · RATE · TAXABLE · AMOUNT`, one row per component per slab. Decathlon's structure.

The renderer picks the mode automatically from the distinct-slab count; `props.mode` can force one.

### Known ambiguity — record, don't paper over
A **fully zero-rated inter-state** bill produces all-zero CGST/SGST/IGST, identical to an intra-state zero-rated bill. The two are indistinguishable from the figures alone. Practical impact is nil (everything displays zero), but the *label* on a tax document matters even at zero. Fixing it properly means storing an explicit `isIntraState` boolean at persist time.

### Document order (fixed across all templates)
```
Items / Charges  →  TOTAL  →  Tax ladder  →  Total Tax  →  AMOUNT PAYABLE
```

---

## 6. Layout model — a deliberate constraint

**Do not build free-form canvas positioning.** It is the obvious reading of "drag and drop", and it is the wrong answer for bills.

A bill must render on a ~380px phone, print to PDF, and survive a variable number of line items. Absolute `x`/`y` coordinates break all three: a bill with 3 items and one with 40 cannot share fixed positions.

**Instead: a vertical stack with row grouping.**
- Blocks stack vertically in `order`.
- Adjacent blocks may be grouped into a **row** when their combined `width` fits (`half + half`, `third + third + third`).
- `width` is a fraction, never pixels — so it reflows on mobile and in print.
- Merchant-editable "dimensions" means *width fraction and vertical spacing*, not pixel boxes.

This still gives the builder a genuine drag-and-drop feel — reorder vertically, drop side-by-side, resize by fraction — while guaranteeing every arrangement renders correctly at any width with any data volume. It also means **no arrangement a merchant can build can produce a broken bill**, which matters when the output is a compliance document.

---

## 7. Bill immutability — the render snapshot

**Decided:** a template edit must never change how an already-issued bill renders.

This is a compliance requirement, not a UX preference. A tax invoice that looks different today than when it was issued is a defective document — BR-2 already states bills are immutable, and layout is part of the document, not a view over it.

### The bug in the current design

Today the renderer reads `bill.template.layoutSchema` through a **live join**. Editing a template therefore silently rewrites every bill ever issued against it. Nothing in the current code prevents this.

### The fix: freeze the render spec onto the bill

At bill-creation time, copy the template's complete resolved render spec into a new `Bill.layoutSnapshot` column. The renderer reads **only** the snapshot, never the live template.

```json
{
  "schemaVersion": 2,
  "skeleton": "RETAIL",
  "theme": { "accentHex": "#df9f3a", "density": "comfortable" },
  "blocks": [ /* full frozen block array, including all props and labels */ ],
  "templateId": "tpl_x7a2",
  "templateVersion": 3
}
```

`templateId` and `templateVersion` are **provenance only** — recorded so you can trace which template produced a bill. They are never used for lookup at render time. That distinction is the whole point: any lookup reintroduces the live dependency.

### Why a separate column, not inside `Bill.snapshot`

`Bill.snapshot` is governed by D-28's exact key-set whitelist test, which exists specifically to guarantee no PII reaches the public page. Layout config is a different kind of thing with different security properties — it holds merchant-authored label strings (untrusted, but not PII). Merging them would bloat that whitelist and blur what it's protecting. Keep the data snapshot and the presentation snapshot separate and separately testable.

### Consequences, stated plainly

- **Bills become fully self-contained.** Deleting a template cannot break historical bills. That's a real robustness gain beyond the immutability requirement.
- **Storage cost is real but small** — a few KB of JSON per bill. Correctness on a compliance document beats storage efficiency; and bills already carry a data snapshot, so the pattern is established.
- **Both write paths must snapshot** — the PG-callback path (P-1) and the direct API path (P-2). A bill created by either must be equally frozen.
- **Merchant branding still drifts.** Logo and brand colours live on `Merchant` and are not snapshotted, so changing them *does* affect old bills. This is accepted: the legally significant merchant fields (name, address, GSTIN) are already frozen inside `Bill.snapshot`. Flagged so it's a known decision rather than an oversight.
- **Existing bills need a backfill** — copy each bill's current template layout into its snapshot. Historically imperfect (they get frozen at today's layout, not the layout in force when issued), but it is the best available and only affects dev data.

### Test that proves it

The regression test that must exist: create a bill, mutate its template's `layoutSchema`, re-resolve the bill, assert the rendered block list is **unchanged**. Without this test the guarantee is a comment, not a property.

### Template versioning (builder feature, not the immutability mechanism)

**Not needed now — recorded for the future builder task.**

When the builder lets merchants edit templates, model edits as **fork-on-write**, not in-place mutation: every edit creates a new `Template` row with `parentTemplateId` pointing at the version it was cloned from, rather than overwriting `layoutSchema` on the existing row. This gives merchants git-like version history — they can see prior versions, and no edit is ever silently destructive.

```prisma
model Template {
  // ...existing fields
  parentTemplateId String?
  parentTemplate    Template?  @relation("TemplateHistory", fields: [parentTemplateId], references: [id])
  versions          Template[] @relation("TemplateHistory")
}
```

**Important — this is a UX feature layered on top of §7, not a replacement for it.** It was considered as the immutability mechanism itself (lock a template once any bill uses it; edits fork a new row) and rejected for that role: enforcing "locked" requires every future write path — including tools that don't exist yet, like an admin data-fix script or a bulk import — to correctly check "has any bill ever referenced this?" before allowing a mutation. Miss that check once, anywhere, and the guarantee silently breaks. The render-snapshot in §7 has no such dependency: bills stop reading templates at render time at all, so there is nothing left to protect and nothing to forget. Fork-on-write is worth having for the version-history it gives merchants, but bill immutability must rest on the snapshot regardless.



```prisma
model Template {
  id           String            @id @default(cuid())
  merchantId   String?           // NULL = library preset
  merchant     Merchant?         @relation(...)
  name         String
  billType     BillType
  industry     TemplateIndustry  // NEW — gallery grouping
  skeleton     TemplateSkeleton  // extend: RESTAURANT, RETAIL, UTILITY, B2B_INVOICE
  layoutSchema Json              // v2 shape (§2)
  version      Int      @default(1)
  isDefault    Boolean  @default(false)  // NEW — one per merchant per billType
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt       // NEW — builder needs it
}

enum TemplateIndustry { RESTAURANT RETAIL UTILITY B2B GENERIC }
```

On `Bill`, the frozen render spec (§7) — **the change that makes bills immutable**:
```prisma
layoutSnapshot Json?   // complete frozen render spec; renderer reads ONLY this,
                       // never bill.template.layoutSchema. Nullable for backfill;
                       // becomes effectively required for all new bills.
```

Plus on `Merchant`, for branding shared across all that merchant's templates:
```prisma
branding Json?   // { logoUrl, primaryHex, secondaryHex, fontFamily }
```

### Validation (enforce at write, re-check at render)
1. Only known block types — reject at save, skip at render.
2. `HEADER` and one of `ITEMS`/`CHARGES` must be present.
3. `order` unique within a template.
4. Block `id` unique within a template.
5. `props` validated against that block type's manifest entry.
6. Exactly one default template per merchant per `billType`.
7. Library templates immutable to merchants; clone produces a **deep copy**, never a reference — central edits must never mutate merchant templates.

---

## 9. Builder-readiness — what today's decisions buy

| Builder capability (Muskan's spec) | Enabled by |
|---|---|
| Components tab: edit a component in isolation | `blocks[].props` + manifest-declared prop schema |
| Rename table headings and field labels | `columns[].label` — separate from `columns[].field` |
| Choose which variables to show | `columns[].visible` |
| Reorder columns | `columns[]` array order |
| Bill tab: add/remove components | Append/remove from `blocks[]` |
| Drag to reorder | Update `blocks[].order` — `id` keeps identity stable |
| Hide without losing config | `blocks[].visible` |
| Edit dimensions on the bill | `blocks[].width` fractions + row grouping (§6) |
| Final look preview | Same renderer, same `layoutSchema` — preview *is* production |
| Start from a default and edit | Library presets + clone-on-edit |

**The last row is the real test:** the builder's preview and the customer's bill must run the same renderer over the same document. Any divergence means merchants design one thing and customers receive another.

---

## 10. Build order

**Now (unblocked, real data exists):**
1. `layoutSchema` v2 — add `schemaVersion`, block `id`, `visible`, `width`. Additive; existing templates keep working.
2. Retail template properly — it maps most directly onto what Phase 2 already stores (line items, HSN, per-rate tax).
3. `TAX_SUMMARY` corrected to the component-row ladder (§5), both modes.
4. Column config model in `ITEMS` — even hardcoded initially, the *shape* must be right, because that shape is the builder's contract.
5. **`Bill.layoutSnapshot` (§7)** — freeze the render spec at bill creation, switch the renderer to read it, backfill existing bills, and add the template-edit regression test. Do this *before* merchants can edit templates, not after.

**Next (needs new data or new UI):**
6. `SAVINGS`, `LOYALTY`, `COUPON`, `SURVEY`, `MARKETING` — need data models; hardcode as demo placeholders first, clearly marked.
7. Restaurant template — needs order type in `BILL_META`.
8. B2B invoice — blocked on the separate authenticated path (`BILL_TO` cannot render on a public page).
9. Utility — needs an entirely different upstream data model (readings, tariffs, billing periods).

**Later:** the builder itself — block manifest as a shared package, palette UI, drag-drop, per-block prop editors, live preview.

---

## 11. Open questions

1. **Zero-rated inter-state ambiguity** (§5) — store an explicit `isIntraState` at persist time, or accept the label risk?
2. **Block manifest location** — a shared package both apps import, or duplicated with a drift test? Today `apps/api` and `apps/web` share no code, and the block enum already exists in only one of them.
3. **Nesting depth** — Shopify allows 8 levels. Bills likely need only one (row grouping). Confirm before the builder locks it in.
4. **Merchant-level label defaults** vs per-template labels — a merchant with three templates may want "Products" everywhere. Merchant-level defaults with per-block override is the flexible answer; per-block only is simpler.
**Resolved:** template-edit immutability — bills freeze their render spec at creation (§7). This was the highest-risk open question; it is now a design requirement with a named regression test, not an open item.
