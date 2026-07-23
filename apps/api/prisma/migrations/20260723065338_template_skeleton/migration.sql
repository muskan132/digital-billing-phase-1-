-- CreateEnum
CREATE TYPE "TemplateSkeleton" AS ENUM ('MINIMALIST', 'COMPACT_THERMAL');

-- AlterTable
ALTER TABLE "Template" ADD COLUMN     "skeleton" "TemplateSkeleton" NOT NULL DEFAULT 'MINIMALIST';
