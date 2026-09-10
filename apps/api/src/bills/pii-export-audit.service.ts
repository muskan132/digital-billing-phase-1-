// E-1 / D-70 / D-71 / D-80: the write path for PiiExportAudit — the compliance
// record that PII left the system in a bulk export.
//
// This is a SERVICE METHOD, NOT A ROUTE. E-2's GET /portal/bills/export.csv is
// the only caller; it awaits record() to completion (== committed) BEFORE it
// streams a single CSV byte, and refuses the export entirely if record()
// rejects (D-48's "precondition" — no committed audit row, no export).
//
// APPEND-ONLY (D-70): this class has exactly one method. No update / delete /
// upsert exists here or anywhere else in the codebase — enforced locally by a
// method-surface test + a repo-wide grep test, since D-70 leaves DB-level
// REVOKE to Compliance. The PiiExportAudit model itself carries no @updatedAt.
//
// NO AUTHORIZATION HERE (D-80): record() records whatever principal it is
// handed. The MERCHANT_ADMIN gate is E-2's route (@Roles), per D-71. A future
// export path that forgets its own @Roles would write audit rows for a
// STORE_STAFF export — E-1 trusts its caller.
//
// This file deliberately emits no diagnostic output — a deny-test scans it.
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type ExportContactProjection = 'masked' | 'full';

// D-80 / MAJOR-3: "the filters used", normalized to plain strings — the values
// the merchant actually asked for, not an internal shape. E-2 maps its parsed
// query to this. `{}` when no filters were applied (the column is non-nullable).
export interface ExportAuditFilters {
  dateFrom?: string;
  dateTo?: string;
  billType?: string;
  source?: string;
}

export interface RecordExportAuditInput {
  // From MerchantContext (E-2 passes them) — NEVER a request field.
  merchantId: string;
  userId: string;
  // D-80 / MAJOR-1: the count of data rows the caller declares it exported.
  // E-1 does NOT run the bill query — E-2 owns it, and passes the count here.
  rowCount: number;
  contactProjection: ExportContactProjection;
  filters: ExportAuditFilters;
}

@Injectable()
export class PiiExportAuditService {
  constructor(private readonly prisma: PrismaService) {}

  // The ONLY method. Resolves only after the row is durably committed (a single
  // Prisma `create` is its own implicit transaction) — that resolution IS the
  // sequencing primitive E-2 relies on: audit first, then stream (D-80).
  //
  // The two validations are a BACKSTOP (D-80 / MINOR-3) — E-2's controller does
  // the user-facing 422 on a bad/missing `contact`; these stop a buggy caller
  // from writing a garbage audit row. Neither writes a row on failure.
  async record(input: RecordExportAuditInput): Promise<{ id: string; createdAt: Date }> {
    if (!Number.isInteger(input.rowCount) || input.rowCount < 0) {
      throw new Error(`PiiExportAudit.rowCount must be a non-negative integer, got: ${input.rowCount}`);
    }
    if (input.contactProjection !== 'masked' && input.contactProjection !== 'full') {
      throw new Error(`PiiExportAudit.contactProjection must be "masked" or "full", got: ${String(input.contactProjection)}`);
    }

    return this.prisma.piiExportAudit.create({
      data: {
        merchantId: input.merchantId,
        userId: input.userId,
        rowCount: input.rowCount,
        contactProjection: input.contactProjection,
        filters: (input.filters ?? {}) as Prisma.InputJsonValue,
      },
      select: { id: true, createdAt: true },
    });
  }
}
