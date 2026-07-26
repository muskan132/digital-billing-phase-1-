-- CreateEnum
CREATE TYPE "OrderSource" AS ENUM ('PG_CALLBACK', 'DIRECT_API');

-- CreateEnum
CREATE TYPE "ApiKeyStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- AlterTable
ALTER TABLE "Bill" ADD COLUMN     "cgstPaise" BIGINT,
ADD COLUMN     "discountPaise" BIGINT,
ADD COLUMN     "igstPaise" BIGINT,
ADD COLUMN     "invoiceNumber" TEXT,
ADD COLUMN     "merchantGstin" TEXT,
ADD COLUMN     "merchantId" TEXT,
ADD COLUMN     "placeOfSupply" TEXT,
ADD COLUMN     "sgstPaise" BIGINT,
ADD COLUMN     "subtotalPaise" BIGINT,
ADD COLUMN     "taxPaise" BIGINT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "externalTransactionId" TEXT,
ADD COLUMN     "saleAt" TIMESTAMP(3),
ADD COLUMN     "source" "OrderSource" NOT NULL DEFAULT 'PG_CALLBACK',
ALTER COLUMN "merchantTxnNo" DROP NOT NULL,
ALTER COLUMN "paymentId" DROP NOT NULL,
ALTER COLUMN "txnId" DROP NOT NULL,
ALTER COLUMN "responseCode" DROP NOT NULL;

-- CreateTable
CREATE TABLE "OrderItem" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "hsn" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPricePaise" BIGINT NOT NULL,
    "itemDiscountPaise" BIGINT NOT NULL,
    "billDiscountAllocPaise" BIGINT NOT NULL,
    "taxRateBp" INTEGER NOT NULL,
    "taxableValuePaise" BIGINT NOT NULL,
    "taxPaise" BIGINT NOT NULL,
    "cgstPaise" BIGINT NOT NULL,
    "sgstPaise" BIGINT NOT NULL,
    "igstPaise" BIGINT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MerchantApiKey" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "keyPrefix" TEXT NOT NULL,
    "keyHash" BYTEA NOT NULL,
    "status" "ApiKeyStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OrderItem_orderId_idx" ON "OrderItem"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "MerchantApiKey_keyPrefix_key" ON "MerchantApiKey"("keyPrefix");

-- CreateIndex
CREATE INDEX "MerchantApiKey_merchantId_idx" ON "MerchantApiKey"("merchantId");

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MerchantApiKey" ADD CONSTRAINT "MerchantApiKey_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill Bill.merchantId from its Order (S-6: existing v1 rows must not be left null).
UPDATE "Bill" AS b
SET "merchantId" = o."merchantId"
FROM "Order" AS o
WHERE o."id" = b."orderId";

-- AlterTable: now that every row is backfilled, merchantId becomes required.
ALTER TABLE "Bill" ALTER COLUMN "merchantId" SET NOT NULL;

-- AddForeignKey (RESTRICT, not SET NULL — merchantId is required, matching Bill.order's
-- implicit Restrict convention elsewhere in this schema).
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateIndex
CREATE UNIQUE INDEX "Bill_merchantId_invoiceNumber_key" ON "Bill"("merchantId", "invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Order_externalTransactionId_key" ON "Order"("externalTransactionId");

-- S-6: exactly one of txnId (callback path) / externalTransactionId (direct API path)
-- must be present — never both, never neither.
ALTER TABLE "Order" ADD CONSTRAINT "order_txnid_xor_externaltransactionid_check"
  CHECK (
    ("txnId" IS NOT NULL AND "externalTransactionId" IS NULL)
    OR ("txnId" IS NULL AND "externalTransactionId" IS NOT NULL)
  );
