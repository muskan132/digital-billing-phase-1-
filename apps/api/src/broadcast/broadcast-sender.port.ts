import { Channel } from '@prisma/client';

export interface BroadcastSendInput {
  channel: Channel;
  recipient: string;
}

// Failure is a sanitized value, not a thrown vendor error: nodemailer's rejection
// errors can embed the raw recipient (e.g. in `rejected` or the message text), so the
// sender must classify and mask before this ever reaches a caller/DB column.
export type BroadcastSendResult =
  | { sent: true }
  | { sent: false; reasonCode: string; message: string };

// D-3: single port/seam behind which a real vendor can later drop in without
// changing any caller (B-2's drainer depends only on this interface).
export interface BroadcastSender {
  sendBroadcast(input: BroadcastSendInput): Promise<BroadcastSendResult>;
}
