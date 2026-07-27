-- AlterEnum
ALTER TYPE "TemplateSkeleton" ADD VALUE 'TAX_COMPLIANT';

-- AlterTable
ALTER TABLE "Merchant" ADD COLUMN     "gstStateCode" TEXT;
