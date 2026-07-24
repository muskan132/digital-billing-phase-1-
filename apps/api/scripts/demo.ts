// Demo-only tooling — never shipped. Builds a signed JioPay callback, POSTs it to the
// running API, looks up the resulting bill link, and opens it in the browser.
// Assumes docker compose + the API + the web app are already running.
//
// Usage: pnpm demo [amount]   (amount defaults to "1.00")

import * as path from 'path';
import { exec } from 'child_process';
import { config } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { computeSecureHash } from '../src/callbacks/secure-hash.util';

config({ path: path.join(__dirname, '..', '.env') });

const API_BASE_URL = process.env.API_BASE_URL ?? 'http://localhost:4000';
const WEB_BASE_URL = process.env.WEB_BASE_URL ?? 'http://localhost:3000';

function openInBrowser(url: string): void {
  const command =
    process.platform === 'win32'
      ? `start "" "${url}"`
      : process.platform === 'darwin'
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(command, { shell: process.platform === 'win32' ? 'cmd.exe' : undefined }, (err) => {
    if (err) {
      console.warn(`Could not auto-open browser (${err.message}) — open the URL above manually.`);
    }
  });
}

async function main() {
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey) {
    throw new Error('SECRET_KEY env var is required to sign the demo callback');
  }

  const amount = process.argv[2] ?? '1.00';
  const txnID = `DEMO-${Date.now()}`;

  const payload: Record<string, unknown> = {
    acqName: 'PayPhi',
    aggregatorID: 'JP2001xxx60985',
    TransmissionDateTime: '20260723123428',
    paymentInstId: '4XXX XXXX XXXX 1111',
    cardNetwork: 'VISA',
    // Obviously fake demo values — this run creates a real Order/Broadcast row
    // visible in Mailhog, never use anything resembling a real person's data.
    customerMobileNo: '9999999999',
    customerEmailID: 'demo@example.com',
    paymentSubInstType: 'DC',
    paymentMode: 'Card',
    amount,
    responseCode: '0000',
    respDescription: 'Transaction successful',
    merchantId: 'JP2000000007',
    merchantTxnNo: `DEMO-MTXN-${Date.now()}`,
    txnID,
    paymentDateTime: '20260723123438',
    paymentID: `DEMO-PAY-${Date.now()}`,
    oth_charge: false,
  };
  payload.secureHash = computeSecureHash(payload, Buffer.from(secretKey, 'utf-8'));

  console.log(`Posting callback for amount=${amount} txnID=${txnID}...`);
  const response = await fetch(`${API_BASE_URL}/v1/callbacks/pg`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    console.error(`Callback POST failed: ${response.status} ${await response.text()}`);
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const order = await prisma.order.findUnique({
      where: { txnId: txnID },
      select: { link: { select: { identifier: true } } },
    });

    if (!order?.link) {
      console.error(
        'Callback accepted but no Link was created — check the API logs (e.g. missing merchant.defaultTemplate).',
      );
      process.exit(1);
    }

    const billUrl = `${WEB_BASE_URL}/${order.link.identifier}`;
    console.log(`Bill URL: ${billUrl}`);
    openInBrowser(billUrl);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Demo script failed:', err);
  process.exit(1);
});
