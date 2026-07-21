import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BroadcastStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BroadcastSenderService } from './broadcast-sender.service';

const DEFAULT_MAX_ATTEMPTS = 5;

@Injectable()
export class BroadcastDrainerService {
  private readonly logger = new Logger(BroadcastDrainerService.name);
  private readonly maxAttempts = Number(process.env.MAX_BROADCAST_ATTEMPTS ?? DEFAULT_MAX_ATTEMPTS);

  // Guards against two ticks draining concurrently: @nestjs/schedule does not await or
  // track a previous invocation before firing the next one, and a batch can take up to
  // N x 5s (B-1's SMTP timeout) to drain — long enough to outlast a 10s tick on a bad run.
  // Without this, two ticks could fetch and send the same PENDING rows before either
  // one's status update lands. Sufficient for v1's single-instance/local-Postgres scope
  // (D-4) — not a distributed lock, which v1 has no multi-worker need for.
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: BroadcastSenderService,
  ) {}

  @Cron('*/10 * * * * *')
  async drain(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Previous drain still running — skipping this tick');
      return;
    }
    this.isRunning = true;
    try {
      await this.drainOnce();
    } finally {
      this.isRunning = false;
    }
  }

  private async drainOnce(): Promise<void> {
    const rows = await this.prisma.broadcast.findMany({
      where: {
        OR: [
          { status: BroadcastStatus.PENDING },
          { status: BroadcastStatus.FAILED, attempts: { lt: this.maxAttempts } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });

    for (const row of rows) {
      try {
        await this.sender.sendBroadcast({ channel: row.channel, recipient: row.recipient });
        await this.prisma.broadcast.update({
          where: { id: row.id },
          data: { status: BroadcastStatus.SENT, sentAt: new Date() },
        });
      } catch (err) {
        // A failed send must not stop the rest of this tick's batch (D-7).
        const message = err instanceof Error ? err.message : String(err);
        await this.prisma.broadcast.update({
          where: { id: row.id },
          data: { status: BroadcastStatus.FAILED, attempts: { increment: 1 }, error: message },
        });
      }
    }
  }
}
