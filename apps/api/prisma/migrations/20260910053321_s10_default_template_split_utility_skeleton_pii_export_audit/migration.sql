-- S-10 (D-60): rename, not drop-and-add — the merchant's existing default
-- template must survive this migration. A drop-and-add would silently null
-- every merchant's default, and the PG callback path treats a missing
-- default as a config error that commits an Order with no Bill.
ALTER TABLE "Merchant" RENAME COLUMN "defaultTemplateId" TO "defaultReceiptTemplateId";
ALTER TABLE "Merchant" RENAME CONSTRAINT "Merchant_defaultTemplateId_fkey" TO "Merchant_defaultReceiptTemplateId_fkey";

-- S-10 (D-60): the second default pointer. Nullable — no positional/seed
-- value is set here; POST /v1/bills keeps its existing fallback chain until
-- F-7 replaces it.
ALTER TABLE "Merchant" ADD COLUMN "defaultTaxInvoiceTemplateId" TEXT;
ALTER TABLE "Merchant" ADD CONSTRAINT "Merchant_defaultTaxInvoiceTemplateId_fkey" FOREIGN KEY ("defaultTaxInvoiceTemplateId") REFERENCES "Template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- S-10 (D-67): UTILITY starter's skeleton value. Additive to the enum, safe
-- on existing rows; not used by any row until I-1 seeds the starter.
ALTER TYPE "TemplateSkeleton" ADD VALUE 'UTILITY';

-- S-10 (D-70/D-71): the export-audit prerequisite. Export-scoped only, not a
-- general audit log. Append-only by convention — no update/delete/upsert
-- method exists anywhere in the codebase for this model; enforced by the
-- absence of those code paths, not by revoked DB privileges (D-70's named,
-- accepted gap).
CREATE TABLE "PiiExportAudit" (
    "id" TEXT NOT NULL,
    "merchantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rowCount" INTEGER NOT NULL,
    "filters" JSONB NOT NULL,
    "contactProjection" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PiiExportAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PiiExportAudit_merchantId_idx" ON "PiiExportAudit"("merchantId");

ALTER TABLE "PiiExportAudit" ADD CONSTRAINT "PiiExportAudit_merchantId_fkey" FOREIGN KEY ("merchantId") REFERENCES "Merchant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PiiExportAudit" ADD CONSTRAINT "PiiExportAudit_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
