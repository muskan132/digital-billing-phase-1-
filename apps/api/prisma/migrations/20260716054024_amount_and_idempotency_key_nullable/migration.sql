-- AlterTable
ALTER TABLE "Order" ALTER COLUMN "idempotencyKey" DROP NOT NULL,
ALTER COLUMN "amountPaise" DROP NOT NULL;
