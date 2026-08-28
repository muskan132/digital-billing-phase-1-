import { BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PortalBillsService } from './portal-bills.service';
import { encodeCursor } from './portal-bills-cursor.util';

const MERCHANT_ID = 'merchant-A';

function rowFixture(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'bill-1',
    createdAt: new Date('2026-08-01T00:00:00.000Z'),
    billType: 'RECEIPT',
    invoiceNumber: 'INV-1',
    totalPaise: 10000n,
    currency: 'INR',
    order: {
      source: 'PG_CALLBACK',
      customerMobile_pii: '9876543210',
      customerEmail_pii: 'anna@example.com',
    },
    ...overrides,
  };
}

describe('PortalBillsService.list — query scoping (H-1 / D-46)', () => {
  it('always includes merchantId in the SAME where object passed to findMany, in the same call that applies filters', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new PortalBillsService({ bill: { findMany } } as unknown as PrismaService);

    await service.list(MERCHANT_ID, { filters: { billType: 'TAX_INVOICE' } });

    expect(findMany).toHaveBeenCalledTimes(1);
    const callArgs = findMany.mock.calls[0][0];
    // merchantId must be reachable from the literal where object handed to
    // Prisma — not applied by filtering the JS array after the fact.
    const whereJson = JSON.stringify(callArgs.where);
    expect(whereJson).toContain(`"merchantId":"${MERCHANT_ID}"`);
    expect(whereJson).toContain('"billType":"TAX_INVOICE"');
  });

  it('folds the source filter into a nested relation condition on order', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new PortalBillsService({ bill: { findMany } } as unknown as PrismaService);

    await service.list(MERCHANT_ID, { filters: { source: 'DIRECT_API' } });

    const where = findMany.mock.calls[0][0].where;
    expect(JSON.stringify(where)).toContain('"order":{"source":"DIRECT_API"}');
  });

  it('folds dateFrom/dateTo into an inclusive createdAt range on the same where', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new PortalBillsService({ bill: { findMany } } as unknown as PrismaService);
    const dateFrom = new Date('2026-08-01T00:00:00.000Z');
    const dateTo = new Date('2026-08-02T00:00:00.000Z');

    await service.list(MERCHANT_ID, { filters: { dateFrom, dateTo } });

    const where = findMany.mock.calls[0][0].where;
    expect(where.createdAt).toEqual({ gte: dateFrom, lte: dateTo });
  });

  it('sorts createdAt DESC, id DESC and requests limit+1 rows to detect a next page', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new PortalBillsService({ bill: { findMany } } as unknown as PrismaService);

    await service.list(MERCHANT_ID, { filters: {}, limit: 20 });

    const args = findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(args.take).toBe(21);
  });

  it('builds the manual OR tie-break condition from a decoded cursor, ANDed with the filter conditions', async () => {
    const findMany = jest.fn().mockResolvedValue([]);
    const service = new PortalBillsService({ bill: { findMany } } as unknown as PrismaService);
    const cursorCreatedAt = new Date('2026-08-01T00:00:00.000Z');
    const cursor = encodeCursor({ createdAt: cursorCreatedAt, id: 'bill-cursor' });

    await service.list(MERCHANT_ID, { filters: {}, cursor });

    const where = findMany.mock.calls[0][0].where;
    expect(where.AND[1]).toEqual({
      OR: [
        { createdAt: { lt: cursorCreatedAt } },
        { AND: [{ createdAt: cursorCreatedAt }, { id: { lt: 'bill-cursor' } }] },
      ],
    });
  });
});

describe('PortalBillsService.list — DTO whitelist (H-1 / D-48)', () => {
  it('emits EXACTLY the D-48 field set — nothing more, nothing from the raw row leaks through', async () => {
    const findMany = jest.fn().mockResolvedValue([rowFixture()]);
    const service = new PortalBillsService({ bill: { findMany } } as unknown as PrismaService);

    const result = await service.list(MERCHANT_ID, { filters: {} });

    expect(result.items).toHaveLength(1);
    const item = result.items[0];
    expect(Object.keys(item).sort()).toEqual(
      [
        'id',
        'createdAt',
        'billType',
        'source',
        'invoiceNumber',
        'totalPaise',
        'currency',
        'customerMobileMasked',
        'customerEmailMasked',
      ].sort(),
    );
  });

  it('never emits the raw _pii values — only the masked projection', async () => {
    const findMany = jest.fn().mockResolvedValue([rowFixture()]);
    const service = new PortalBillsService({ bill: { findMany } } as unknown as PrismaService);

    const result = await service.list(MERCHANT_ID, { filters: {} });
    const item = result.items[0];
    const serialized = JSON.stringify(item);

    expect(serialized).not.toContain('9876543210');
    expect(serialized).not.toContain('anna@example.com');
    expect(item.customerMobileMasked).toBe('98****3210');
    expect(item.customerEmailMasked).toBe('a***@example.com');
  });

  it('serializes totalPaise (BigInt) as a decimal string, never a number', async () => {
    const findMany = jest.fn().mockResolvedValue([rowFixture({ totalPaise: 123456789012345n })]);
    const service = new PortalBillsService({ bill: { findMany } } as unknown as PrismaService);

    const result = await service.list(MERCHANT_ID, { filters: {} });
    expect(result.items[0].totalPaise).toBe('123456789012345');
    expect(typeof result.items[0].totalPaise).toBe('string');
  });

  it('masks to null (not a placeholder string) when contact is absent', async () => {
    const findMany = jest
      .fn()
      .mockResolvedValue([rowFixture({ order: { source: 'PG_CALLBACK', customerMobile_pii: null, customerEmail_pii: null } })]);
    const service = new PortalBillsService({ bill: { findMany } } as unknown as PrismaService);

    const result = await service.list(MERCHANT_ID, { filters: {} });
    expect(result.items[0].customerMobileMasked).toBeNull();
    expect(result.items[0].customerEmailMasked).toBeNull();
  });
});

describe('PortalBillsService.list — pagination bookkeeping', () => {
  it('nextCursor is null when the row count is within the page (no phantom extra page)', async () => {
    const findMany = jest.fn().mockResolvedValue([rowFixture({ id: 'a' }), rowFixture({ id: 'b' })]);
    const service = new PortalBillsService({ bill: { findMany } } as unknown as PrismaService);

    const result = await service.list(MERCHANT_ID, { filters: {}, limit: 5 });
    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBeNull();
  });

  it('drops the lookahead row and returns a nextCursor keyed on the last KEPT row when more rows exist', async () => {
    const rows = [rowFixture({ id: 'a' }), rowFixture({ id: 'b' }), rowFixture({ id: 'c' })]; // limit+1 = 3, limit = 2
    const findMany = jest.fn().mockResolvedValue(rows);
    const service = new PortalBillsService({ bill: { findMany } } as unknown as PrismaService);

    const result = await service.list(MERCHANT_ID, { filters: {}, limit: 2 });
    expect(result.items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(result.nextCursor).not.toBeNull();
  });
});

describe('PortalBillsService.list — validation', () => {
  const findMany = jest.fn();
  const service = new PortalBillsService({ bill: { findMany } } as unknown as PrismaService);

  it('defaults to limit 20 when omitted', async () => {
    findMany.mockResolvedValue([]);
    await service.list(MERCHANT_ID, { filters: {} });
    expect(findMany.mock.calls[0][0].take).toBe(21);
  });

  it('rejects limit above 100', async () => {
    await expect(service.list(MERCHANT_ID, { filters: {}, limit: 101 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects limit below 1', async () => {
    await expect(service.list(MERCHANT_ID, { filters: {}, limit: 0 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a malformed cursor with 400, not a crash', async () => {
    await expect(service.list(MERCHANT_ID, { filters: {}, cursor: 'not-a-valid-cursor' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
