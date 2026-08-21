-- S-9: additive only. +User.subject/disabledAt/lastLoginAt, +MerchantSession.
-- No column added/changed on Merchant, Order, Bill, or Template.

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "disabledAt" TIMESTAMP(3),
ADD COLUMN     "lastLoginAt" TIMESTAMP(3),
ADD COLUMN     "subject" TEXT;

-- CreateTable
CREATE TABLE "MerchantSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" BYTEA NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MerchantSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MerchantSession_tokenHash_key" ON "MerchantSession"("tokenHash");

-- CreateIndex
CREATE INDEX "MerchantSession_userId_revokedAt_idx" ON "MerchantSession"("userId", "revokedAt");

-- CreateIndex
CREATE UNIQUE INDEX "User_subject_key" ON "User"("subject");

-- AddForeignKey
ALTER TABLE "MerchantSession" ADD CONSTRAINT "MerchantSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
