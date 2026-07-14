---
name: code-review
description: Reviews code diffs, PRs, functions, or modules for correctness, security, and maintainability. Declares tier first (T1 for money/auth/user-data/published APIs, T2 otherwise), checks the invariants that matter (idempotency, authorization at the resource, failure paths, no floats on money), and delivers severity-ranked feedback where nitpicks never block. Also the solo-mode reviewer: run it as the cold second pair of eyes before merging own code. Not for writing new code, not for debugging broken behavior, not for system-level design questions.
---

# Code Review

## When this fires
A diff, PR, file, or module needs review — including my own code before merge (the solo-mode second pair of eyes).

## Procedure
1. **Declare the tier.** T1 (money, auth, user data, published contracts) or T2 (internal, experimental). The whole review calibrates to this; T1 rigor on a throwaway script is a defect too — say so and downshift.
2. **Size check.** >~400 lines: the honest options are "split this" or a skim-level pass explicitly labeled as one. Never deliver skim confidence as review confidence.
3. **Invariants pass (the review's actual job) — check against this list explicitly:**
   - Money: integers/decimals never floats; mutations idempotent; ledger-append not balance-mutate; test floor present (happy/retry/partial/concurrent/reconciles).
   - Auth: authorization at the *resource* (ownership checked at data access — the IDOR check), not just at the route.
   - Failure: every error handled, propagated with context, or explicitly accepted — no swallowed catches, no retries without budgets.
   - Boundaries: input parsed-not-validated at trust edges; output encoded per context (HTML/SQL/shell); no secrets in code or logs.
   - Contracts: backward compatibility on anything published; migrations expand-migrate-contract.
4. **Correctness-ladder pass:** does it run → happy path → edges (empty/null/huge/concurrent/malicious) → maintainable → fast. Flag rung-order violations (optimization atop untested edges).
5. **Scope pass:** diff matches the stated intent? Smuggled refactors get named — proposed separately, not blocking, but named.
6. **Deliver severity-ranked:** **[blocking]** correctness/security/invariants · **[should]** design worth a conversation · **[nit]** preference, explicitly never blocking. Every [blocking] states the failure scenario, not just the rule.

## Output template
```
CODE REVIEW: [diff] — Tier: T1/T2 — Size: [ok / split-advised / skim-labeled]
[blocking] … (failure scenario: …)
[should] …
[nit] … (non-blocking)
Verdict: merge / merge-after-blocking / split
```

## Rules
- Review the change, not the author. Steelman the code's intent before criticizing its expression.
- Uncertain whether an API/behavior claim is true → say "verify: …" rather than asserting.
- A review with zero findings on non-trivial T1 code is suspect — say what was checked and found clean, so the clean bill is auditable.

## Do NOT use when
Something is broken (debugging — mechanism first), the question is architectural (architecture-review), or code needs to be written (coding mode).

*Source: SW Eng Methodology v1.0 Ph.2–3, 7.2–7.3*
