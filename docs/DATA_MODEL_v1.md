# DATA MODEL v1 — Prisma-ready (single Postgres, local)

Money is **integer paise** (`BigInt`, `_paise` suffix) — never float (matches TDS §1 + prisma.md). Rupee strings from JioPay (`"1.00"`) are converted to paise by **string/decimal parse, never `parseFloat(x)*100`**. Field names track the TDS data dictionary where one exists.

**PII boundary (kept simple for v1):** `customerMobile` / `customerEmail` live on `Order` (suffixed `_pii`); `Broadcast.recipient` is the one derived copy the worker needs to send. Both are PII — never written to `Link.identifier`, logs, or any other row. v1 stores them **plaintext-at-rest in local Postgres** (local UAT only); the encrypt-at-rest / PII-Vault split from the old design is **deferred** (see GAPS).

```prisma
// datasource: postgresql. All money BigInt paise. All ids cuid unless noted.

enum UserType    { EXTERNAL  INTERNAL }              // EXTERNAL=merchant-side, INTERNAL=platform-side
enum UserRole    { STORE_STAFF  MERCHANT_ADMIN  OPS_SUPPORT  PLATFORM_ADMIN }
enum BillType    { RECEIPT  TAX_INVOICE }
enum OrderStatus { SUCCESS  NON_SUCCESS }            // v1 only persists SUCCESS -> Bill
enum Channel     { SMS  EMAIL }
enum BroadcastStatus { PENDING  SENT  FAILED }       // queue states; PENDING = enqueued, not yet sent
enum OrderSource { PG_CALLBACK  DIRECT_API }         // v2: which invocation path made this Order (D-18); drives billType per BR-21
enum ApiKeyStatus { ACTIVE  REVOKED }                // v2: merchant direct-API credential lifecycle (D-19)

model Merchant {
  id             String   @id @default(cuid())
  jiopayMid      String   @unique                    // callback merchantId, e.g. "JP200...007"
  name           String
  secretKeyEnc   Bytes                                // SECRET_KEY for secureHash; seeded, not logged
  users          User[]
  templates      Template[]
  orders         Order[]
  defaultChannel Channel  @default(EMAIL)             // channel for PENDING Broadcasts created by P-1 (D-11)
  defaultTemplateId String?
  defaultTemplate   Template? @relation("MerchantDefault", fields: [defaultTemplateId], references: [id])
  gstin          String?                              // v2: merchant GSTIN, required for TAX_INVOICE (BR-4). 15 chars; chars 1-2 = state code
  state          String?                              // v2: 2-digit GST state code, e.g. "27". MUST equal gstin[0:2]. Compared to placeOfSupply (D-25)
  apiKeys        MerchantApiKey[]                     // v2 (D-19)
  createdAt      DateTime @default(now())
}

model MerchantApiKey {                                // v2: direct-API credential. NOT secretKeyEnc — different purpose + rotation lifecycle (D-19)
  id         String   @id @default(cuid())
  merchantId String
  merchant   Merchant @relation(fields: [merchantId], references: [id])
  keyPrefix  String   @unique                         // first 8 chars of the key, plaintext — the lookup handle; not a secret
  keyHash    Bytes                                    // SHA-256 of the full key. Constant-time compare. Plaintext never stored, never logged
  label      String?
  status     ApiKeyStatus @default(ACTIVE)
  lastUsedAt DateTime?
  revokedAt  DateTime?
  createdAt  DateTime @default(now())
  @@index([merchantId, status])
}

model User {                                          // v1: seeded, NO auth
  id         String   @id @default(cuid())
  merchantId String?                                  // NULL for INTERNAL platform users
  merchant   Merchant? @relation(fields: [merchantId], references: [id])
  type       UserType
  role       UserRole
  email      String   @unique
  createdAt  DateTime @default(now())
}

model Template {                                      // predefined; 1-2 seeded rows
  id           String   @id @default(cuid())
  merchantId   String?                                // NULL = shared library
  merchant     Merchant? @relation(fields: [merchantId], references: [id])
  name         String
  billType     BillType
  layoutSchema Json                                   // ORDERED block array (see DECISIONS_v1)
  version      Int      @default(1)
  bills        Bill[]
  defaultOf    Merchant[] @relation("MerchantDefault")
  createdAt    DateTime @default(now())
}

model Order {                                         // v1: payment facts from the callback. v2: "a sale", from EITHER path (D-18)
  id                String   @id @default(cuid())
  merchantId        String
  merchant          Merchant @relation(fields: [merchantId], references: [id])
  source            OrderSource @default(PG_CALLBACK)  // v2 (D-18). Existing rows backfill to PG_CALLBACK
  idempotencyKey    String                             // audit only, NON-unique; "PG:"+merchantTxnNo+"#"+paymentID (TDS). Not an enforcement key — see D-9
  merchantTxnNo     String?                            // v2: nullable — PG path only
  paymentId         String?                            // v2: nullable — PG path only
  txnId             String?  @unique                   // JioPay txnID — PG-path idempotency key (D-8/D-9). v2: NULLABLE (direct path has none). Postgres UNIQUE ignores NULLs, so many direct orders coexist
  externalTransactionId String? @unique                // v2: DIRECT_API idempotency key, caller-supplied (BR-1, D-18). Its own constraint — never conflated with txnId
  amountPaise       BigInt?                            // PG: from amount string rupees. DIRECT: == Bill.totalPaise. null only per D-15
                                                         // null for NON_SUCCESS orders or any SUCCESS callback whose amount failed to parse (see D-15)
  currency          String   @default("INR")           // v2: DIRECT path validates ISO-4217 from payload (BR-4); PG path stays hardcoded "INR"
  responseCode      String?                            // "0000" = success. v2: nullable — PG path only
  paymentMode       String?
  paymentDateTime   String?                            // raw "yyyyMMddHHmmss" from callback
  saleAt            DateTime?                          // v2: store-local time of sale from the direct payload (BR-6). NOT server receive time
  status            OrderStatus                        // DIRECT_API orders are always SUCCESS — a direct call asserts a completed sale
  customerMobile_pii String?                           // PII — see boundary note
  customerEmail_pii  String?                           // PII — see boundary note
  rawCallback       Json                               // raw inbound payload, audit/replay. v2: also holds the direct-API request body (name kept — L-2's exclusion list keys on it)
  items             OrderItem[]                        // v2: TAX_INVOICE line items; empty for RECEIPT orders (BR-23)
  bill              Bill?
  link              Link?
  broadcasts        Broadcast[]
  createdAt         DateTime @default(now())
  @@index([merchantId])
  // DB CHECK (raw migration SQL, not expressible in Prisma):
  //   (source='PG_CALLBACK' AND txnId IS NOT NULL AND externalTransactionId IS NULL)
  //   OR (source='DIRECT_API' AND externalTransactionId IS NOT NULL AND txnId IS NULL)
  // Without this, an Order with both keys null is unreachable-but-writable and idempotency silently dies.
}

model OrderItem {                                      // v2: an invoice line. Every money/tax value is the COMPUTED value, persisted — the invoice is immutable and must never be re-derived at render time (BR-2)
  id                 String   @id @default(cuid())
  orderId            String
  order              Order    @relation(fields: [orderId], references: [id])
  lineNo             Int                               // 1-based, caller order preserved; also the tie-break for discount remainder allocation (D-23)
  name               String                            // merchant-supplied, free text — output-encoded at render
  hsn                String                            // HSN/SAC. Required on every line, including zero-rated (D-26)
  uom                String                            // unit of measure (BR-4)
  quantity           Int                               // whole units only in v2 — fractional quantity is a GAP, not built
  unitPricePaise     BigInt                            // >= 0
  itemDiscountPaise  BigInt   @default(0)              // caller-supplied, <= quantity * unitPricePaise
  billDiscountAllocPaise BigInt @default(0)            // this line's share of the bill-level discount (D-23). Persisted so the allocation is auditable, not recomputed
  taxRateBp          Int                               // basis points, integer. 0 valid (D-26). 1800 = 18%
  taxableValuePaise  BigInt                            // computed: quantity*unitPrice - itemDiscount - billDiscountAlloc
  taxPaise           BigInt                            // computed, half-up, per-line (D-24)
  cgstPaise          BigInt   @default(0)              // exactly one of {cgst+sgst} / {igst} is non-zero (D-25)
  sgstPaise          BigInt   @default(0)
  igstPaise          BigInt   @default(0)
  @@unique([orderId, lineNo])
  @@index([orderId])
}

model Bill {                                           // billing document rendered from a template
  id             String   @id @default(cuid())
  orderId        String   @unique                      // 1:1 with Order
  order          Order    @relation(fields: [orderId], references: [id])
  merchantId     String                                // v2: denormalized from Order solely to make the invoice-number uniqueness constraint expressible at the DB
  billType       BillType
  templateId     String                                // template_id_used
  template       Template @relation(fields: [templateId], references: [id])
  totalPaise     BigInt
  currency       String   @default("INR")
  snapshot       Json                                  // resolved values the renderer fills into the template — WHITELISTED, see D-17 / D-28
  artifactVer    Int      @default(1)                  // bump on re-render
  // --- v2 TAX_INVOICE fields. All null on a RECEIPT (BR-23: GST validation never applies to receipts) ---
  invoiceNumber  String?                               // CALLER-SUPPLIED, required for TAX_INVOICE (D-20). The core generates no sequence
  subtotalPaise  BigInt?                               // sum of (qty*unitPrice) before any discount
  discountPaise  BigInt?                               // item discounts + bill-level discount, combined
  taxPaise       BigInt?                               // sum of per-line tax; == cgst+sgst+igst (D-24)
  cgstPaise      BigInt?
  sgstPaise      BigInt?
  igstPaise      BigInt?
  placeOfSupply  String?                               // 2-digit GST state code from the payload (D-25)
  merchantGstin  String?                               // SNAPSHOT of Merchant.gstin at issue time — a later GSTIN change must not mutate an issued invoice (BR-2)
  createdAt      DateTime @default(now())
  @@unique([merchantId, invoiceNumber])                // v2: an invoice number is unique per merchant. NULLs (receipts) are ignored by Postgres
}

model Link {                                           // identifier -> order (public capability)
  id         String   @id @default(cuid())
  identifier String   @unique                          // short code, e.g. "abc123" -> jbill.in/abc123
  orderId    String   @unique
  order      Order    @relation(fields: [orderId], references: [id])
  createdAt  DateTime @default(now())
}

model Broadcast {                                       // the queue itself (NO Kafka/Redis in v1)
  id         String   @id @default(cuid())
  orderId    String
  order      Order    @relation(fields: [orderId], references: [id])
  channel    Channel                                    // SMS | EMAIL
  recipient  String                                     // phone/email — PII; masked in logs (see boundary)
  status     BroadcastStatus @default(PENDING)
  attempts   Int      @default(0)
  error      String?                                    // last failure reason; nullable
  createdAt  DateTime @default(now())                   // FIFO ordering key
  sentAt     DateTime?                                  // set when status -> SENT
  @@index([status, createdAt])                          // worker: oldest PENDING first
}
```

**Notes**
- Idempotency: `UNIQUE(txnId)` is the **sole** enforcement point; callback processing is an **upsert on `txnId`** inside one transaction, so a redelivered callback creates no duplicate Order/Bill/Link/Broadcast (D-8/D-9). `idempotencyKey` is a **non-unique** TDS-derived audit column only.
- Non-success callbacks: persist `Order(status=NON_SUCCESS)`, **no Bill, no Link, no Broadcast** (park + log).
- `secretKeyEnc` / `*_pii` are `Bytes`/nullable columns; never emit them in logs, errors, or events. Send happens in the worker **after commit**, never inside the transaction (matches prisma.md).
- **v2 idempotency:** two keys, two paths, never conflated. `txnId` for `PG_CALLBACK`, `externalTransactionId` for `DIRECT_API`; each has its own UNIQUE, and the CHECK constraint on `Order` guarantees exactly one is populated. The direct path upserts on `externalTransactionId` using the same nested-write-in-`create`-branch pattern P-1 established (D-18) — including `OrderItem` rows, which are nested children like Bill/Link/Broadcast and must never be separate `.create()` calls.
- **v2 money:** every amount stays `BigInt` paise; every tax rate stays an integer in basis points (`Int`). No `Float`, no `Decimal`, no string math anywhere in the calculation path. Computed line values are persisted (`OrderItem`), never recomputed at render.
- **v2 credentials:** `MerchantApiKey.keyHash` is a SHA-256 digest of a high-entropy random key (not a password KDF — the input has full entropy, so a slow KDF buys nothing). Lookup is by `keyPrefix`, comparison is constant-time. The plaintext key exists exactly once, at creation.
- `Bill` is added because step 2 persists "the order **and a bill**" and step 4 renders "the bill". Order = payment; Bill = document. (Flagged in GAPS — the entity list named Orders only.)
