# ARCHIVED v1 — set aside for the reset (not deleted, not authoritative for v1)

These remain the historical record. v1 does **not** build to them; consult only when a v1 gap forces a decision they already answered.

## Canonical specs (scope far beyond v1)
- `FSD_..._v1_0-r1.docx` — full functional spec (12 modules, portals, widgets, DPDP, credit notes). v1 uses only the callback→bill→link→render happy path.
- `Architecture_Blueprint_..._v1_2.docx` — multi-store, Kafka, CDN microsite, K8s target architecture. v1 is single-Postgres + local.
- `Technical_Design_Specification_..._v1_0-r1.docx` — KV Bill Store / Metering Ledger / event envelopes / adapters. Kept as the field-name & idempotency-key reference; not built wholesale.
- `Engineering_Execution_Roadmap_....xlsx` — 262 tasks across P0–P5+Launch. Superseded for v1 by the 4 steps in `SCOPE_v1.md`.

## Governance / process docs (the "too much documentation" being reset)
- `00_Project_Brain.md`, `01_STATE.md`, `STATE.md`, `02_CONTEXT_SYSTEM.md`, `CONTEXT_SYSTEM.md` — authority hierarchy, session state, context pipeline. Not needed to build one local slice.
- `IMPLEMENTATION_PLAYBOOK.md`, `REVIEW_POLICY.md`, `DECISION_MATRIX.md`, `CLAUDE_PLAYBOOK.md` — per-task workflow, L0–L3 review routing, autonomy modifiers. Reset; do **not** recreate for v1.
- `decision.md` (ADR-001/002 dup, ADR-003), `technical_debt.md` (TD-001…TD-010), `implementation_logs.md` — prior ledgers tied to the F-track/vendor/deploy work that v1 drops.
- `software_engineering_methodology_v1_0.md`, `architecture_review_SKILL.md`, `code_review_SKILL.md`, `debuggin_SKILL.md` — method/skill library; useful later, not v1 scope docs.

## Rules files (informed v1, not rebuilt as-is)
- `prisma.md` — money-as-paise, PII boundary, idempotent writes carried forward into `DATA_MODEL_v1.md`; multi-store / Vault / expand-contract rules **deferred**.
- `rbac.md`, `security.md`, `portals.md`, `architecture.md`, `backend.md`, `frontend-design.md`, `jpsl-design-system.md`, `tech-stack.md` — role matrix, four-portal split, adapter/observability floor. v1 seeds users (no auth) and serves one public page; most of this is deferred.

## Explicitly deferred scope (recorded, not designed)
- Drag-and-drop template builder → v1: 1–2 seeded JSON templates.
- Merchant/Admin/Support portals + auth (OIDC/MFA/OTP) → v1: seeded DB rows.
- Real SMS/Email/WhatsApp vendors → v1: stub + Mailhog.
- KV Bill Store, Metering Ledger, Kafka/events, analytics, compliance scrub/DPDP, offline queue, credit notes, engagement widgets, CDN microsite → all deferred.
