// TEMPORARY — manual B-1 verification script. Not part of the permanent codebase.
// Delete this file once B-2 exists and can be verified end-to-end instead.
//
// Usage: pnpm exec ts-node scripts/manual-test-broadcast.ts [email]
// Requires `docker compose up -d` (Mailhog on :1025/:8025) running first.

import { Channel } from '@prisma/client';
import { BroadcastSenderService } from '../src/broadcast/broadcast-sender.service';

async function main() {
  const service = new BroadcastSenderService();
  const email = process.argv[2] ?? 'customer@example.com';

  console.log('Sending EMAIL broadcast...');
  const emailResult = await service.sendBroadcast({ channel: Channel.EMAIL, recipient: email });
  console.log('EMAIL result:', emailResult, '— check http://localhost:8025 for the message');

  console.log('Sending SMS broadcast (log-only, no external call)...');
  const smsResult = await service.sendBroadcast({ channel: Channel.SMS, recipient: '9876543210' });
  console.log('SMS result:', smsResult);
}

main().catch((err) => {
  console.error('Manual broadcast test failed:', err);
  process.exit(1);
});
