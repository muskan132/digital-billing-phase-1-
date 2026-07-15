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
  createdAt      DateTime @default(now())
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

model Order {                                         // payment facts from the callback
  id                String   @id @default(cuid())
  merchantId        String
  merchant          Merchant @relation(fields: [merchantId], references: [id])
  idempotencyKey    String                             // audit only, NON-unique; "PG:"+merchantTxnNo+"#"+paymentID (TDS). Not an enforcement key — see D-9
  merchantTxnNo     String
  paymentId         String
  txnId             String   @unique                   // JioPay txnID — UNIQUE = at-least-once idempotency key (D-8, upsert target)
  amountPaise       BigInt                             // from amount string rupees; >= 0
  currency          String   @default("INR")
  responseCode      String                             // "0000" = success
  paymentMode       String?
  paymentDateTime   String?                            // raw "yyyyMMddHHmmss" from callback
  status            OrderStatus
  customerMobile_pii String?                           // PII — see boundary note
  customerEmail_pii  String?                           // PII — see boundary note
  rawCallback       Json                               // stored for audit/replay
  bill              Bill?
  link              Link?
  broadcasts        Broadcast[]
  createdAt         DateTime @default(now())
  @@index([merchantId])
}

model Bill {                                           // billing document rendered from a template
  id             String   @id @default(cuid())
  orderId        String   @unique                      // 1:1 with Order
  order          Order    @relation(fields: [orderId], references: [id])
  billType       BillType
  templateId     String                                // template_id_used
  template       Template @relation(fields: [templateId], references: [id])
  totalPaise     BigInt
  currency       String   @default("INR")
  snapshot       Json                                  // resolved values the renderer fills into the template
  artifactVer    Int      @default(1)                  // bump on re-render
  createdAt      DateTime @default(now())
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
- `Bill` is added because step 2 persists "the order **and a bill**" and step 4 renders "the bill". Order = payment; Bill = document. (Flagged in GAPS — the entity list named Orders only.)
