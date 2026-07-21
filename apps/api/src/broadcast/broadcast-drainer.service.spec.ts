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
    sentAt: null,
    ...overrides,
  };
}

describe('BroadcastDrainerService', () => {
  let findMany: jest.Mock;
  let update: jest.Mock;
  let sendBroadcast: jest.Mock;
  let service: BroadcastDrainerService;

  beforeEach(() => {
    findMany = jest.fn();
    update = jest.fn().mockResolvedValue(undefined);
    sendBroadcast = jest.fn();
    const prisma = { broadcast: { findMany, update } } as unknown as PrismaService;
    const sender = { sendBroadcast } as unknown as BroadcastSenderService;
    service = new BroadcastDrainerService(prisma, sender);
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
    sendBroadcast.mockRejectedValueOnce(new Error('SMTP timeout')).mockResolvedValueOnce({ sent: true });

    await service.drain();

    expect(sendBroadcast).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'a' },
      data: { status: BroadcastStatus.FAILED, attempts: { increment: 1 }, error: 'SMTP timeout' },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'b' },
      data: { status: BroadcastStatus.SENT, sentAt: expect.any(Date) },
    });
  });

  it('excludes rows at or past max-attempts from being retried', async () => {
    findMany.mockResolvedValue([]);
    await service.drain();

    const call = findMany.mock.calls[0][0];
    expect(call.where.OR[1]).toEqual({ status: BroadcastStatus.FAILED, attempts: { lt: 5 } });
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
