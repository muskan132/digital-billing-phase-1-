import * as fs from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma/prisma.service';
import { PiiExportAuditService, RecordExportAuditInput } from './pii-export-audit.service';

const VALID: RecordExportAuditInput = {
  merchantId: 'merchant-A',
  userId: 'user-1',
  rowCount: 42,
  contactProjection: 'full',
  filters: { dateFrom: '2026-08-01', billType: 'RECEIPT' },
};

function makeService() {
  const create = jest.fn().mockResolvedValue({ id: 'audit-1', createdAt: new Date('2026-09-10T00:00:00Z') });
  const service = new PiiExportAuditService({ piiExportAudit: { create } } as unknown as PrismaService);
  return { service, create };
}

describe('PiiExportAuditService.record', () => {
  it('writes exactly one row with the field values from the input, and returns { id, createdAt }', async () => {
    const { service, create } = makeService();
    const result = await service.record(VALID);

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      data: {
        merchantId: 'merchant-A',
        userId: 'user-1',
        rowCount: 42,
        contactProjection: 'full',
        filters: { dateFrom: '2026-08-01', billType: 'RECEIPT' },
      },
      select: { id: true, createdAt: true },
    });
    expect(result).toEqual({ id: 'audit-1', createdAt: new Date('2026-09-10T00:00:00Z') });
  });

  it('stores {} (not null) when no filters were applied', async () => {
    const { service, create } = makeService();
    await service.record({ ...VALID, filters: {} });
    expect((create.mock.calls[0][0] as { data: { filters: unknown } }).data.filters).toEqual({});
  });

  it('records the masked projection verbatim', async () => {
    const { service, create } = makeService();
    await service.record({ ...VALID, contactProjection: 'masked' });
    expect((create.mock.calls[0][0] as { data: { contactProjection: string } }).data.contactProjection).toBe('masked');
  });

  it('BACKSTOP: rejects a negative / non-integer rowCount without writing a row (D-80 MINOR-3)', async () => {
    const { service, create } = makeService();
    await expect(service.record({ ...VALID, rowCount: -1 })).rejects.toThrow(/non-negative integer/);
    await expect(service.record({ ...VALID, rowCount: 3.5 })).rejects.toThrow(/non-negative integer/);
    expect(create).not.toHaveBeenCalled();
  });

  it('BACKSTOP: rejects a contactProjection outside {masked, full} without writing a row', async () => {
    const { service, create } = makeService();
    await expect(service.record({ ...VALID, contactProjection: 'partial' as never })).rejects.toThrow(/masked.*full/);
    expect(create).not.toHaveBeenCalled();
  });

  it('rowCount 0 is valid (an empty export is still an audited act)', async () => {
    const { service, create } = makeService();
    await service.record({ ...VALID, rowCount: 0 });
    expect((create.mock.calls[0][0] as { data: { rowCount: number } }).data.rowCount).toBe(0);
  });
});

describe('PiiExportAuditService — append-only surface (E-1 / D-70)', () => {
  it('THE method-surface test — the class exposes EXACTLY `record`, nothing else (no update/delete/upsert)', () => {
    expect(Object.getOwnPropertyNames(PiiExportAuditService.prototype).sort()).toEqual(['constructor', 'record']);
  });

  it('THE repo-wide grep test — no PRODUCTION code anywhere calls piiExportAudit.update/updateMany/delete/deleteMany/upsert', () => {
    // D-70's "no update/delete/upsert method exists anywhere" is about product
    // code paths — a service method, a controller, a script. Test teardown that
    // deletes its OWN scratch rows (unavoidable: the merchant/user FKs are
    // ON DELETE RESTRICT) is not that, so *.spec.ts is excluded from the scan.
    const roots = [path.join(__dirname, '..'), path.join(__dirname, '..', '..', 'scripts')];
    const offenders: string[] = [];
    const mutation = /piiExportAudit\s*\.\s*(update|updateMany|delete|deleteMany|upsert)\b/i;

    function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist') continue;
          walk(full);
        } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')) {
          if (mutation.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
        }
      }
    }
    for (const r of roots) if (fs.existsSync(r)) walk(r);

    expect(offenders).toEqual([]);
  });

  it('the PiiExportAudit model carries no @updatedAt — no mutation affordance on the row itself', () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', '..', 'prisma', 'schema.prisma'), 'utf8');
    const block = schema.slice(schema.indexOf('model PiiExportAudit'));
    const modelBody = block.slice(0, block.indexOf('}') + 1);
    expect(modelBody).not.toMatch(/@updatedAt/);
    // sanity: we actually captured the right block
    expect(modelBody).toMatch(/contactProjection/);
  });

  it('the service file emits no diagnostic output (deny-test discipline)', () => {
    const src = fs.readFileSync(path.join(__dirname, 'pii-export-audit.service.ts'), 'utf8');
    expect(src).not.toMatch(/\bLogger\b|console\./);
  });
});
