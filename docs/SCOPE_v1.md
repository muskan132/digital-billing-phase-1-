# SCOPE v1 — Digital Billing Core (local happy path)

One slice, run entirely **locally**, to pass **local UAT**. Everything else in the old docs is set aside (see `ARCHIVED_v1.md`).

## In scope (the 4 steps)
1. **Receive** a JioPay S2S payment callback — `POST /v1/callbacks/pg`, `application/json`. Verify `secureHash`.
2. **Persist on success (one transaction)** — on `responseCode == "0000"`, write the **Order**, **Bill**, **Link**, and a **PENDING Broadcasts** row in a **single DB transaction**. Idempotent: `UNIQUE(txnID)` + upsert, so a redelivered callback never duplicates any of them.
3. **Short link** — the Link (`identifier → order`) is minted inside that same transaction; `jbill.in/<identifier>` (e.g. `jbill.in/abc123`). The link never depends on the broadcast being sent — the request path only *enqueues* (writes the PENDING row); no send happens inline.
4. **Serve the link-view page** — public page renders the Bill into its predefined template → **PDF download** + **share**.
5. **Drain the broadcast queue** — a **NestJS scheduled worker** picks the oldest `PENDING` `Broadcasts` row (**FIFO by `createdAt`**) and sends it. **Send is STUBBED**: log line + email to **Mailhog** (local SMTP), no real vendor. Success → `SENT`; failure → `FAILED` + `attempts++`, retried on a later pass (no head-of-line blocking).

## Out of scope (deferred, not designed — see ARCHIVED_v1.md)
- Drag-and-drop template builder → v1 ships **1–2 predefined JSON templates**, seeded.
- Merchant portal + user auth → v1 **seeds** merchant / users / defaults in the DB.
- Real SMS / email vendor → v1 **stubs** the send (row + log + Mailhog).
- KV Bill Store / Metering Ledger / Kafka / multi-store split / analytics / compliance-scrub / offline queue / credit notes / widgets → all deferred; v1 is **single-Postgres, synchronous**.

## Ground truth (fetched, not invented)
- Callback shape: `https://docs.jiopay.in/docs/webhooks` (S2S JSON example). `amount` is a **string in rupees** (`"1.00"`); `responseCode "0000"` = success.
- `secureHash`: HMAC-SHA256, **sort keys alphabetically → concatenate values (no delimiter) → hex lowercase**, keyed by the merchant `SECRET_KEY` — `https://docs.jiopay.in/docs/generate-hash`.
- Index: `https://docs.jiopay.in/llms.txt`.

## Definition of "done" (local UAT passes)
- A signed S2S callback with `responseCode "0000"` → **one** Order + **one** Bill + **one** Link + **one** PENDING Broadcasts row, all in one transaction; **replaying the same callback (same `txnID`) changes nothing** — no duplicate order/link/broadcast.
- Bad/missing `secureHash` → rejected (401), nothing persisted. `responseCode != "0000"` → parked/logged, no Bill/Link/Broadcast.
- `GET jbill.in/<identifier>` returns the rendered bill in its template; **PDF downloads**; **share** works.
- The worker moves the PENDING row to `SENT` (email visible in **Mailhog**); a forced failure sets `FAILED` + `attempts++` and is retried on the next pass while later items still send.
- No floats anywhere in the money path. No PII in logs. Whole flow runs with `docker compose up` locally — no cloud vendor.
