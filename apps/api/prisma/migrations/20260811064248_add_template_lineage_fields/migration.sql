-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "isHead" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "parentTemplateId" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3);

-- Backfill: existing rows get updatedAt = createdAt (S-8)
UPDATE "Template" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL;

-- AlterTable
ALTER TABLE "Template" ALTER COLUMN "updatedAt" SET NOT NULL;

-- CreateIndex
CREATE INDEX "Template_merchantId_isHead_archivedAt_idx" ON "Template"("merchantId", "isHead", "archivedAt");

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_parentTemplateId_fkey" FOREIGN KEY ("parentTemplateId") REFERENCES "Template"("id") ON DELETE SET NULL ON UPDATE CASCADE;
