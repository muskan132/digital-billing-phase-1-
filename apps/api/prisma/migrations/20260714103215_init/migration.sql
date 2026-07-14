-- CreateEnum
CREATE TYPE "UserType" AS ENUM ('EXTERNAL', 'INTERNAL');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('STORE_STAFF', 'MERCHANT_ADMIN', 'OPS_SUPPORT', 'PLATFORM_ADMIN');

-- CreateEnum
CREATE TYPE "BillType" AS ENUM ('RECEIPT', 'TAX_INVOICE');

-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('SUCCESS', 'NON_SUCCESS');

-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('SMS', 'EMAIL');

-- CreateEnum
CREATE TYPE "BroadcastStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "Merchant" (
    "id" TEXT NOT NULL,
    "jiopayMid" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "secretKeyEnc" BYTEA NOT NULL,
    "defaultTemplateId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Merchant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT,
    "type" "UserType" NOT NULL,
    "role" "UserRole" NOT NULL,
    "email" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT,
    "name" TEXT NOT NULL,
    "billType" "BillType" NOT NULL,
    "layoutSchema" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "merchantTxnNo" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "txnId" TEXT NOT NULL,
    "amountPaise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "responseCode" TEXT NOT NULL,
    "paymentMode" TEXT,
    "paymentDateTime" TEXT,
    "status" "OrderStatus" NOT NULL,
    "customerMobile_pii" TEXT,
    "customerEmail_pii" TEXT,
    "rawCallback" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bill" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "billType" "BillType" NOT NULL,
    "templateId" TEXT NOT NULL,
    "totalPaise" BIGINT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "snapshot" JSONB NOT NULL,
    "artifactVer" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Link" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Broadcast" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" "BroadcastStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "Broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Merchant_jiopayMid_key" ON "Merchant"("jiopayMid");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Order_txnId_key" ON "Order"("txnId");

-- CreateIndex
CREATE INDEX "Order_merchantId_idx" ON "Order"("merchantId");

-- CreateIndex
CREATE UNIQUE INDEX "Bill_orderId_key" ON "Bill"("orderId");

-- CreateIndex
CREATE UNIQUE INDEX "Link_identifier_key" ON "Link"("identifier");

-- CreateIndex
CREATE UNIQUE INDEX "Link_orderId_key" ON "Link"("orderId");

-- CreateIndex
CREATE INDEX "Broadcast_status_createdAt_idx" ON "Broadcast"("status", "createdAt");

-- AddForeignKey
ALTER TABLE "Merchant" ADD CONSTRAINT "Merchant_defaultTemplateId_fkey" FOREIGN KEY ("defaultTemplateId") REFERENCES "Template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "Template"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Link" ADD CONSTRAINT "Link_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Broadcast" ADD CONSTRAINT "Broadcast_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
