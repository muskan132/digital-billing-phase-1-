# Digital Billing v1 — standing rules for every session

Read docs/SCOPE_v1.md, docs/DATA_MODEL_v1.md, docs/DECISIONS_v1.md,
docs/ROADMAP_v1.md before starting any task.

- Work ONE roadmap task at a time, in order. State which task ID you're doing.
- Tier-1 tasks (flagged in the roadmap): give a 3–5 line plan, then STOP and wait
  for explicit approval before writing code.
- Non-Tier-1 tasks: proceed after a short plan, no wait needed.
- Money: integer paise (BigInt) or Decimal — never float, never parseFloat.
- Never log raw customer mobile/email — mask in all logs.
- Never invent an API field, hash algorithm, or vendor not in docs/ or already
  in the repo — if it's missing, stop and say so.
- Smallest diff that satisfies the task. No drive-by refactors.
- When a task is done: tell me the exact command to verify it, then stop.
  Don't start the next task automatically.

  - Never modify docs/*.md — those are frozen for v1. If something's wrong or missing
  in them, tell me; don't silently patch around it or edit them yourself.
- Never touch .env or commit secrets/keys. Ask me if a new env var is needed.
- If a roadmap task's "Verify locally" step doesn't pass, stop and tell me what
  failed — don't move to the next task, don't work around it.

  - For V-1/V-2/V-3/V-4 (the bill view page), also read docs/UI_STYLE_v1.md.