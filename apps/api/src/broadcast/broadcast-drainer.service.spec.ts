import { BroadcastStatus, Channel } from '@prisma/client';
import { BroadcastDrainerService } from './broadcast-drainer.service';
import { PrismaService } from '../prisma/prisma.service';
import { BroadcastSenderService } from './broadcast-sender.service';

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'b1',
    orderId: 'o1',
    channel: Channel.EMAIL,
    recipient: 'a@example.com',
    status: BroadcastStatus.PENDING,
    attempts: 0,
    error: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    sentAt: null,
    ...overrides,
  };
}

describe('BroadcastDrainerService', () => {
  let findMany: jest.Mock;
  let update: jest.Mock;
  let sendBroadcast: jest.Mock;
  let service: BroadcastDrainerService;
  const originalMaxAttemptsEnv = process.env.MAX_BROADCAST_ATTEMPTS;

  function makeService() {
    findMany = jest.fn();
    update = jest.fn().mockResolvedValue(undefined);
    sendBroadcast = jest.fn();
    const prisma = { broadcast: { findMany, update } } as unknown as PrismaService;
    const sender = { sendBroadcast } as unknown as BroadcastSenderService;
    return new BroadcastDrainerService(prisma, sender);
  }

  beforeEach(() => {
    delete process.env.MAX_BROADCAST_ATTEMPTS;
    service = makeService();
  });

  afterEach(() => {
    if (originalMaxAttemptsEnv === undefined) {
      delete process.env.MAX_BROADCAST_ATTEMPTS;
    } else {
      process.env.MAX_BROADCAST_ATTEMPTS = originalMaxAttemptsEnv;
    }
  });

  it('queries PENDING and FAILED-under-max-attempts, ordered by createdAt ascending', async () => {
    findMany.mockResolvedValue([]);
    await service.drain();

    expect(findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { status: BroadcastStatus.PENDING },
          { status: BroadcastStatus.FAILED, attempts: { lt: 5 } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('a failing row does not stop later rows in the same batch from sending', async () => {
    const rowA = makeRow({ id: 'a', createdAt: new Date('2026-01-01T00:00:00Z') });
    const rowB = makeRow({ id: 'b', createdAt: new Date('2026-01-01T00:00:01Z') });
    findMany.mockResolvedValue([rowA, rowB]);
    sendBroadcast
      .mockResolvedValueOnce({ sent: false, reasonCode: 'timeout', message: 'SMTP send failed for a***@example.com' })
      .mockResolvedValueOnce({ sent: true });

    await service.drain();

    expect(sendBroadcast).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'a' },
      data: {
        status: BroadcastStatus.FAILED,
        attempts: { increment: 1 },
        error: 'timeout: SMTP send failed for a***@example.com',
      },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'b' },
      data: { status: BroadcastStatus.SENT, sentAt: expect.any(Date) },
    });
  });

  // Decision 1's sender contract sanitizes anticipated failures internally, but a throw
  // escaping that contract entirely (a bug, not a vendor failure) is still caught here
  // as a defensive fallback.
  it('a send call that unexpectedly throws (escaping the sanitized contract) is still recorded as FAILED', async () => {
    const row = makeRow({ id: 'a' });
    findMany.mockResolvedValue([row]);
    sendBroadcast.mockRejectedValueOnce(new Error('unexpected bug'));

    await service.drain();

    expect(update).toHaveBeenCalledWith({
      where: { id: 'a' },
      data: { status: BroadcastStatus.FAILED, attempts: { increment: 1 }, error: 'unexpected_error: unexpected bug' },
    });
  });

  it('a DB failure recording SENT after a successful send does not mark the row FAILED', async () => {
    const row = makeRow({ id: 'a' });
    findMany.mockResolvedValue([row]);
    sendBroadcast.mockResolvedValue({ sent: true });
    update.mockRejectedValueOnce(new Error('connection reset'));

    await service.drain();

    // Only the SENT update was attempted for this row — no FAILED/attempts++ write,
    // since the send itself succeeded (would otherwise cause a duplicate send on retry).
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'a' },
      data: { status: BroadcastStatus.SENT, sentAt: expect.any(Date) },
    });
  });

  it('a DB failure recording FAILED does not abort the rest of the batch', async () => {
    const rowA = makeRow({ id: 'a', createdAt: new Date('2026-01-01T00:00:00Z') });
    const rowB = makeRow({ id: 'b', createdAt: new Date('2026-01-01T00:00:01Z') });
    findMany.mockResolvedValue([rowA, rowB]);
    sendBroadcast.mockRejectedValueOnce(new Error('SMTP timeout')).mockResolvedValueOnce({ sent: true });
    update.mockRejectedValueOnce(new Error('db unavailable')).mockResolvedValueOnce(undefined);

    await expect(service.drain()).resolves.toBeUndefined();

    expect(sendBroadcast).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'b' },
      data: { status: BroadcastStatus.SENT, sentAt: expect.any(Date) },
    });
  });

  it('throws a clear boot-time error for a non-positive-integer MAX_BROADCAST_ATTEMPTS', () => {
    process.env.MAX_BROADCAST_ATTEMPTS = '0';
    expect(() => makeService()).toThrow(/MAX_BROADCAST_ATTEMPTS must be a positive integer/);

    process.env.MAX_BROADCAST_ATTEMPTS = '-3';
    expect(() => makeService()).toThrow(/MAX_BROADCAST_ATTEMPTS must be a positive integer/);

    process.env.MAX_BROADCAST_ATTEMPTS = 'abc';
    expect(() => makeService()).toThrow(/MAX_BROADCAST_ATTEMPTS must be a positive integer/);

    process.env.MAX_BROADCAST_ATTEMPTS = '2.5';
    expect(() => makeService()).toThrow(/MAX_BROADCAST_ATTEMPTS must be a positive integer/);
  });

  it('accepts a valid positive-integer MAX_BROADCAST_ATTEMPTS', async () => {
    process.env.MAX_BROADCAST_ATTEMPTS = '3';
    const customService = makeService();
    findMany.mockResolvedValue([]);

    await customService.drain();

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ status: BroadcastStatus.PENDING }, { status: BroadcastStatus.FAILED, attempts: { lt: 3 } }] },
      }),
    );
  });

  // Decision 2: backoff table [10, 30, 60, 120, 300]s indexed by attempts.
  it('excludes a FAILED row from this tick when its backoff window has not elapsed', async () => {
    const row = makeRow({
      id: 'a',
      status: BroadcastStatus.FAILED,
      attempts: 1, // needs 30s since updatedAt
      updatedAt: new Date(Date.now() - 5000), // only 5s ago
    });
    findMany.mockResolvedValue([row]);

    await service.drain();

    expect(sendBroadcast).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('includes a FAILED row once its backoff window has elapsed', async () => {
    const row = makeRow({
      id: 'a',
      status: BroadcastStatus.FAILED,
      attempts: 1, // needs 30s since updatedAt
      updatedAt: new Date(Date.now() - 35000), // 35s ago — past the 30s window
    });
    findMany.mockResolvedValue([row]);
    sendBroadcast.mockResolvedValue({ sent: true });

    await service.drain();

    expect(sendBroadcast).toHaveBeenCalledTimes(1);
  });

  it('never applies backoff to PENDING rows (never attempted yet)', async () => {
    const row = makeRow({
      id: 'a',
      status: BroadcastStatus.PENDING,
      updatedAt: new Date(), // just created/updated, "backoff" would otherwise exclude it
    });
    findMany.mockResolvedValue([row]);
    sendBroadcast.mockResolvedValue({ sent: true });

    await service.drain();

    expect(sendBroadcast).toHaveBeenCalledTimes(1);
  });

  it('skips a tick if the previous drain is still running (overlap guard)', async () => {
    let resolveSend: (value: { sent: true }) => void = () => {};
    const pendingSend = new Promise<{ sent: true }>((resolve) => {
      resolveSend = resolve;
    });
    sendBroadcast.mockReturnValue(pendingSend);
    findMany.mockResolvedValue([makeRow()]);

    const firstTick = service.drain();
    const secondTick = service.drain(); // fires while firstTick's send is still pending

    // Let firstTick's drainOnce reach the sendBroadcast call before resolving it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    resolveSend({ sent: true });
    await Promise.all([firstTick, secondTick]);

    expect(findMany).toHaveBeenCalledTimes(1);
  });
});
