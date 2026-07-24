# SCOPE v2 — Direct merchant API (itemized GST Tax Invoice)

Phase 2 **extends** v1; it replaces nothing. The callback path, the link, the renderer, and the broadcast queue all keep working exactly as they do today. This adds a second front door onto the same pipeline.

## In scope
1. **`POST /v1/bills`** — direct itemized Tax Invoice creation, authenticated per merchant.
2. **Auth** — per-merchant API key behind an `ApiKeyGuard` seam (D-19). `merchantId` from the key, never the body; mismatched body merchant → `403` (BR-15).
3. **Line items** — per item: name, quantity, unit price (paise), HSN/SAC, UOM, tax rate (basis points), optional item discount.
4. **Calculation validation** (BR-3, FSD 5.2) — recompute the whole ladder in integer paise, compare to supplied, **reject on any mismatch; never silently correct** (D-22, D-23, D-24).
5. **GST validation** (BR-4, BR-5, FSD 5.3) — HSN per line, ISO-4217 currency, UOM, place of supply, merchant GSTIN; CGST+SGST vs IGST derived by the core from place of supply (D-25).
6. **Idempotency** on `external_transaction_id` (BR-1), its own unique constraint, same nested-write upsert pattern as P-1 (D-18).
7. **`billType = TAX_INVOICE` forced by path** (BR-21) — the field is not in the DTO; a caller cannot request a receipt.
8. **`TAX_COMPLIANT` template skeleton** rendering real line items and the GST breakdown.
9. **Reuse** of the existing Link, render, and broadcast pipeline — unchanged.

## The flow
```
POST /v1/bills  --ApiKeyGuard--> merchantId resolved from key
  -> DTO shape validation (line items required, BR-22)
  -> GST field validation (G-1)        --fail--> 422 GST_FIELD_MISSING {field}, no write
  -> calculation recompute + compare   --fail--> 422 CALC_MISMATCH {field, expected, supplied}, no write
  -> ONE transaction: upsert Order on externalTransactionId,
       nested-create OrderItem[] + Bill + Link + PENDING Broadcast
       (update: {} on every branch -> replay no-ops)
  -> 201 { bill_id, identifier, url }        replay -> 200, same body, nothing written
        |
        +-- existing scheduled drainer picks up the PENDING Broadcast -> Mailhog (unchanged)
        +-- jbill.in/<identifier> renders on the TAX_COMPLIANT template (unchanged route)
```

## Out of scope — deferred, **not designed**
`POST /v1/bills/batch` · `POST /v1/credit-notes` · the customer bill portal · server-side PDF generation · the drag-and-drop template builder · e-invoicing / IRN integration · WhatsApp channel.

Also deferred, and named here so they are not silently lost: fractional quantities (weight-priced goods), the recipient/buyer details block required on B2B invoices, cess, reverse charge, and the exempt-vs-zero-rated-vs-nil distinction. See GAPS & RISKS.

## Definition of "done" (local UAT passes)
- A valid signed-in `POST /v1/bills` with 2+ line items at **different tax rates** → **exactly one** Order + N OrderItems + Bill + Link + PENDING Broadcast, in one transaction; `201` with a live URL.
- **Replaying the same `external_transaction_id` → `200`, identical body, all five row counts unchanged.** No second email.
- A payload whose supplied total is off **by one paise** → `422 CALC_MISMATCH`, and `SELECT count(*)` on all five tables is unchanged.
- Missing HSN on any line, missing UOM, missing `place_of_supply`, missing merchant GSTIN, or a non-ISO currency → `422 GST_FIELD_MISSING {field}`, nothing written.
- `place_of_supply == Merchant.state` → CGST+SGST populated, IGST zero; a different code → IGST populated, CGST/SGST zero. Both verified in the DB and on the rendered page.
- A zero-rated line (`tax_rate_bp = 0`) with HSN present is **accepted** and prints; the same line **without** HSN is rejected.
- No API key → `401`. Revoked key → `401`. Valid key + a body naming another merchant → `403`.
- `jbill.in/<identifier>` renders the invoice with per-line HSN/UOM/rate/tax and a GST summary whose printed line taxes **sum exactly** to the printed total.
- The unchanged drainer sends the invoice notification to Mailhog.
- **No floats, anywhere.** Grep the calculation path for `Float`, `Decimal`, `parseFloat`, `Number(`, `/ 100`. No PII in logs. The L-2 whitelist assertion still passes with the new fields present.
- Every existing v1 test still green — the callback path is untouched.
