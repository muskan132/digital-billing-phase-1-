import { Channel } from '@prisma/client';

export interface BroadcastSendInput {
  channel: Channel;
  recipient: string;
}

export interface BroadcastSendResult {
  sent: true;
}

// D-3: single port/seam behind which a real vendor can later drop in without
// changing any caller (B-2's drainer depends only on this interface).
export interface BroadcastSender {
  sendBroadcast(input: BroadcastSendInput): Promise<BroadcastSendResult>;
}
