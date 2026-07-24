-- AlterTable
-- Backfill existing rows to now() at migration time (Prisma's @updatedAt attribute is
-- client-managed on every future write; this DB-level default only satisfies the
-- NOT NULL constraint for the 18 pre-existing rows).
ALTER TABLE "Broadcast" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
