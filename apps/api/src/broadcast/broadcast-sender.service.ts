import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import * as nodemailer from 'nodemailer';
import { BroadcastSendInput, BroadcastSendResult, BroadcastSender } from './broadcast-sender.port';
import { maskEmail, maskMobile } from '../common/mask.util';

const SMTP_TIMEOUT_MS = 5000;

@Injectable()
export class BroadcastSenderService implements BroadcastSender {
  private readonly logger = new Logger(BroadcastSenderService.name);

  // Created once and reused (not per-call): nodemailer's default SMTP transport is
  // non-pooled (pool: false), so reusing this object only reuses connection config —
  // sendMail() still opens a fresh SMTP connection per call and closes it after, so
  // there's no stale/broken connection held across calls. The timeouts below apply to
  // each such connection attempt.
  private readonly transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
    secure: false,
    // D-7: a hung SMTP connection must not stall the queue indefinitely — bound every
    // phase of the connection so a hang throws instead of hanging forever, letting
    // B-2's caller catch it and mark the row FAILED for retry.
    connectionTimeout: SMTP_TIMEOUT_MS,
    greetingTimeout: SMTP_TIMEOUT_MS,
    socketTimeout: SMTP_TIMEOUT_MS,
  });

  async sendBroadcast(input: BroadcastSendInput): Promise<BroadcastSendResult> {
    if (input.channel === Channel.EMAIL) {
      try {
        await this.transporter.sendMail({
          from: 'billing@jbill.in',
          to: input.recipient,
          subject: 'Your bill',
          text: 'Your bill is ready.',
        });
      } catch (err) {
        // Classify from the error code, never surface the vendor's raw message/`rejected`
        // list — those can contain the unmasked recipient. `message` is built from a
        // fixed template using only the masked recipient, regardless of what nodemailer
        // actually said.
        const code = (err as { code?: string })?.code;
        const reasonCode =
          code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT'
            ? 'timeout'
            : code === 'ECONNREFUSED'
              ? 'connection_refused'
              : 'smtp_error';
        const message = `SMTP send failed for ${maskEmail(input.recipient)}`;
        this.logger.error(`Broadcast send failed — channel=EMAIL reasonCode=${reasonCode} ${message}`);
        return { sent: false, reasonCode, message };
      }
      this.logger.log(`Broadcast sent — channel=EMAIL recipient=${maskEmail(input.recipient)}`);
      return { sent: true };
    }

    // SMS: log-only stub, no external call — the log line must say so, not "sent".
    this.logger.log(`Broadcast logged (SMS stub, no external send) — recipient=${maskMobile(input.recipient)}`);
    return { sent: true };
  }
}
