import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { BroadcastStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BroadcastSenderService } from './broadcast-sender.service';

const DEFAULT_MAX_ATTEMPTS = 5;

// D-7 backoff, indexed by `attempts` (seconds to wait since the last attempt before the
// next retry is eligible). Sum ≈ 520s (~8.7 min) of tolerated downstream outage before a
// row permanently exhausts DEFAULT_MAX_ATTEMPTS.
const BACKOFF_SECONDS = [10, 30, 60, 120, 300];

function isBackoffElapsed(row: { attempts: number; updatedAt: Date }): boolean {
  const waitSeconds = BACKOFF_SECONDS[row.attempts] ?? BACKOFF_SECONDS[BACKOFF_SECONDS.length - 1];
  return Date.now() - row.updatedAt.getTime() >= waitSeconds * 1000;
}

// Boot-time validation: a misconfigured value must fail loudly, not silently compute
// NaN/0 and disable retries with no log line.
function resolveMaxAttempts(): number {
  const raw = process.env.MAX_BROADCAST_ATTEMPTS;
  if (raw === undefined) return DEFAULT_MAX_ATTEMPTS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`MAX_BROADCAST_ATTEMPTS must be a positive integer, got: "${raw}"`);
  }
  return parsed;
}

@Injectable()
export class BroadcastDrainerService {
  private readonly logger = new Logger(BroadcastDrainerService.name);
  private readonly maxAttempts = resolveMaxAttempts();

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
    const candidates = await this.prisma.broadcast.findMany({
      where: {
        OR: [
          { status: BroadcastStatus.PENDING },
          { status: BroadcastStatus.FAILED, attempts: { lt: this.maxAttempts } },
        ],
      },
      orderBy: { createdAt: 'asc' },
    });

    // Backoff gate: Prisma's declarative `where` can't compare a row's own `attempts`
    // against a per-row dynamic threshold in one query, so this is a JS-level filter
    // applied right after the DB-level status/max-attempts filter. PENDING rows are
    // never attempted yet, so they're exempt from backoff entirely.
    const rows = candidates.filter((row) => row.status === BroadcastStatus.PENDING || isBackoffElapsed(row));

    for (const row of rows) {
      // Only the send call itself is guarded here — a DB write failure afterwards must
      // never be misclassified as a send failure (that would mark a successfully-sent
      // broadcast FAILED and cause a duplicate send on retry). A throw escaping the
      // sender's own contract (a bug, not an anticipated vendor failure) is still
      // caught here as a defensive fallback, using the raw error message as before.
      let failure: { reasonCode: string; message: string } | null = null;
      try {
        const result = await this.sender.sendBroadcast({ channel: row.channel, recipient: row.recipient });
        if (!result.sent) {
          failure = { reasonCode: result.reasonCode, message: result.message };
        }
      } catch (err) {
        failure = { reasonCode: 'unexpected_error', message: err instanceof Error ? err.message : String(err) };
      }

      if (failure === null) {
        try {
          await this.prisma.broadcast.update({
            where: { id: row.id },
            data: { status: BroadcastStatus.SENT, sentAt: new Date() },
          });
        } catch (updateErr) {
          // Send succeeded but recording it failed — must not mark FAILED (would
          // duplicate-send on retry). Log loudly rather than silently losing this.
          this.logger.error(
            `Broadcast ${row.id} sent successfully but failed to record SENT status: ${
              updateErr instanceof Error ? updateErr.message : String(updateErr)
            }`,
          );
        }
      } else {
        // A failed send must not stop the rest of this tick's batch (D-7). Guard this
        // recovery write too — a DB blip here must not abort the loop either.
        try {
          await this.prisma.broadcast.update({
            where: { id: row.id },
            data: {
              status: BroadcastStatus.FAILED,
              attempts: { increment: 1 },
              error: `${failure.reasonCode}: ${failure.message}`,
            },
          });
        } catch (updateErr) {
          this.logger.error(
            `Broadcast ${row.id} failed to send AND failed to record FAILED status: ${
              updateErr instanceof Error ? updateErr.message : String(updateErr)
            }`,
          );
        }
      }
    }
  }
}
