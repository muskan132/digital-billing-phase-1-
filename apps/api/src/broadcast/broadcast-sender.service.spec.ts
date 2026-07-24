import { Channel } from '@prisma/client';
import { BroadcastSenderService } from './broadcast-sender.service';

describe('BroadcastSenderService', () => {
  let service: BroadcastSenderService;
  let sendMail: jest.Mock;
  let logSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new BroadcastSenderService();
    sendMail = jest.fn().mockResolvedValue(undefined);
    // Replace the transporter with a stub so tests never touch the network.
    (service as unknown as { transporter: { sendMail: jest.Mock } }).transporter = { sendMail };
    logSpy = jest.spyOn((service as unknown as { logger: { log: jest.Mock } }).logger, 'log');
    errorSpy = jest.spyOn((service as unknown as { logger: { error: jest.Mock } }).logger, 'error');
  });

  it('EMAIL: sends via the SMTP transport and logs a masked recipient', async () => {
    const result = await service.sendBroadcast({ channel: Channel.EMAIL, recipient: 'jane@example.com' });

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0].to).toBe('jane@example.com');
    expect(result).toEqual({ sent: true });

    const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain('jane@example.com');
    expect(logged).toContain('j***@example.com');
  });

  it('SMS: never touches the transport, logs a masked recipient only, and never claims "sent"', async () => {
    const result = await service.sendBroadcast({ channel: Channel.SMS, recipient: '9876543210' });

    expect(sendMail).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: true });

    const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain('9876543210');
    // Nothing was actually transmitted (SMS is log-only) — the log line must say so.
    expect(logged).toContain('SMS stub, no external send');
    expect(logged).not.toContain('Broadcast sent');
  });

  // D-3/CTO review: nodemailer failures must be caught and sanitized inside the sender,
  // never thrown as a raw vendor error — that error can embed the raw recipient.
  it('EMAIL: a timeout error returns a sanitized { sent: false } result, never the raw error or recipient', async () => {
    const rawError = Object.assign(new Error('Connection timeout for jane@example.com'), { code: 'ETIMEDOUT' });
    sendMail.mockRejectedValue(rawError);

    const result = await service.sendBroadcast({ channel: Channel.EMAIL, recipient: 'jane@example.com' });

    expect(result).toEqual({ sent: false, reasonCode: 'timeout', message: 'SMTP send failed for j***@example.com' });

    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain('jane@example.com');
    expect(logged).not.toContain('Connection timeout for');
  });

  it('EMAIL: an unrecognized error classifies as "smtp_error", still sanitized', async () => {
    const rawError = Object.assign(new Error('rejected: jane@example.com'), { code: 'EENVELOPE' });
    sendMail.mockRejectedValue(rawError);

    const result = await service.sendBroadcast({ channel: Channel.EMAIL, recipient: 'jane@example.com' });

    expect(result).toEqual({ sent: false, reasonCode: 'smtp_error', message: 'SMTP send failed for j***@example.com' });

    const logged = [...logSpy.mock.calls, ...errorSpy.mock.calls].map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain('jane@example.com');
    expect(logged).not.toContain('rejected: jane');
  });
});
