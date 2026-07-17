import { Channel } from '@prisma/client';
import { BroadcastSenderService } from './broadcast-sender.service';

describe('BroadcastSenderService', () => {
  let service: BroadcastSenderService;
  let sendMail: jest.Mock;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new BroadcastSenderService();
    sendMail = jest.fn().mockResolvedValue(undefined);
    // Replace the transporter with a stub so tests never touch the network.
    (service as unknown as { transporter: { sendMail: jest.Mock } }).transporter = { sendMail };
    logSpy = jest.spyOn((service as unknown as { logger: { log: jest.Mock } }).logger, 'log');
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

  it('SMS: never touches the transport, logs a masked recipient only', async () => {
    const result = await service.sendBroadcast({ channel: Channel.SMS, recipient: '9876543210' });

    expect(sendMail).not.toHaveBeenCalled();
    expect(result).toEqual({ sent: true });

    const logged = logSpy.mock.calls.map((call) => String(call[0])).join('\n');
    expect(logged).not.toContain('9876543210');
  });
});
