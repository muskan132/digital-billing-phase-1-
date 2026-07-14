# UI Style — v1 bill microsite only

Applies to: the public bill-view page (V-2), PDF (V-3), share (V-4). Nothing else
in v1 has a UI.

## Rules (from org frontend-design.md, customer-surfaces section)
- Mobile-first: fast load, readable bill hierarchy, obvious PDF/share actions.
- Dependency-light: no heavy client runtime; a broken widget/asset hides that
  block, it never breaks the rest of the bill.
- Money renders from integer paise via a shared formatter — no ad hoc arithmetic
  in components.

## Tokens (from jpsl-design-system.md — use these, not arbitrary values)
:root {
  --primary: #df9f3a; --ink: #212529; --slate: #6b6358; --canvas: #ffffff;
  --surface: #fef7ef; --hairline: #e6e0d4;
  --semantic-success: #2e7d32; --semantic-error: #c62828;
}
Typography: body-md = 16px/400/1.55. heading-3 = 28px/600 (bill title).
Radius: buttons/inputs = 8px. Cards = 12px.
Icons: Lucide only, no emoji.