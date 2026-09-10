// F-6 — default selection, per bill type. Proves, against a REAL database and a
// REAL signed JioPay callback over HTTP, the two things a mocked test cannot:
//
//   1. TemplatesService.setDefault() writes the pointer matching the template's
//      own billType, leaves the other pointer untouched, and returns ONLY the
//      two pointer ids — never the raw Merchant row (secretKeyEnc / gstin /
//      address / support contacts). BLOCKER-1's regression lock.
//   2. The PG callback path renders the NEW receipt default on the next
//      callback — Bill.templateId AND Bill.layoutSnapshot.templateId both point
//      at the freshly-set default. The render-through, not assumed.
//
// The direct-API (`POST /v1/bills`) render-through of defaultTaxInvoiceTemplateId
// is F-7's job (D-61 / D-27 one-way door) and is NOT exercised here — F-6 only
// proves the pointer is written.
//
// Usage: pnpm --filter @digital-billing/api verify:f6   (apps/api server + docker compose must be running)

import * as path from 'path';
import { config } from 'dotenv';
import { NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { TemplatesService } from '../src/templates/templates.service';
import { computeSecureHash } from '../src/callbacks/secure-hash.util';

config({ path: path.join(__dirname, '..', '.env') });

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';
const MERCHANT_ID = 'seed-merchant-demo';
const MERCHANT_JIOPAY_MID = 'JP2000000007';

const prisma = new PrismaClient();
const templatesService = new TemplatesService(new PrismaService());

let counter = 0;
function uid(prefix: string): string {
  counter += 1;
  return `f6-verify-${prefix}-${Date.now()}-${counter}`;
}

// Throw, never process.exit() — an in-flight exit skips the finally cleanup.
function fail(message: string): never {
  throw new Error(`FAIL — ${message}`);
}
function pass(message: string): void {
  console.log(`PASS  ${message}`);
}

const MINIMAL_LAYOUT = {
  schemaVersion: 2,
  skeleton: 'MINIMALIST',
  blocks: [
    { id: 'blk_h', type: 'HEADER', order: 1, props: {}, visible: true, width: 'full' },
    { id: 'blk_i', type: 'ITEMS', order: 2, props: {}, visible: true, width: 'full' },
  ],
};

async function postSignedCallback(txnID: string): Promise<Response> {
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey) fail('SECRET_KEY env var is required to sign the callback');
  const payload: Record<string, unknown> = {
    acqName: 'PayPhi',
    cardNetwork: 'VISA',
    paymentInstId: '4XXX XXXX XXXX 1111',
    customerEmailID: 'demo@example.com',
    paymentMode: 'Card',
    amount: '1.00',
    responseCode: '0000',
    respDescription: 'Transaction successful',
    merchantId: MERCHANT_JIOPAY_MID,
    merchantTxnNo: uid('mtxn'),
    txnID,
    paymentDateTime: '20260910123438',
    paymentID: uid('pay'),
  };
  payload.secureHash = computeSecureHash(payload, Buffer.from(secretKey, 'utf-8'));
  return fetch(`${API_BASE}/v1/callbacks/pg`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function main() {
  console.log('\n=== verify-f6-default-selection ===\n');

  const baselineTemplateCount = await prisma.template.count();
  const merchantBefore = await prisma.merchant.findUniqueOrThrow({
    where: { id: MERCHANT_ID },
    select: { defaultReceiptTemplateId: true, defaultTaxInvoiceTemplateId: true },
  });

  const created: string[] = [];
  const txnID = uid('txn');

  try {
    // --- 1. setDefault RECEIPT: pointer write + response shape ---------------
    const newReceipt = await prisma.template.create({
      data: { id: uid('tpl'), merchantId: MERCHANT_ID, name: uid('Receipt'), billType: 'RECEIPT', layoutSchema: MINIMAL_LAYOUT, isHead: true },
    });
    created.push(newReceipt.id);

    const setReceiptResult = await templatesService.setDefault(newReceipt.id, MERCHANT_ID);

    const keys = Object.keys(setReceiptResult).sort();
    if (keys.join(',') !== 'defaultReceiptTemplateId,defaultTaxInvoiceTemplateId') {
      fail(`setDefault returned unexpected keys: ${keys.join(', ')}`);
    }
    for (const forbidden of ['secretKeyEnc', 'gstin', 'addressLine1', 'supportEmail', 'supportPhone', 'name', 'jiopayMid', 'id']) {
      if (forbidden in setReceiptResult) fail(`setDefault LEAKED "${forbidden}" in its response`);
    }
    if (/Buffer|secretKeyEnc/i.test(JSON.stringify(setReceiptResult))) fail('setDefault response serialized a Buffer / secretKeyEnc');
    pass('setDefault(RECEIPT) response is exactly { defaultReceiptTemplateId, defaultTaxInvoiceTemplateId } — no secretKeyEnc/gstin/address/support');

    if (setReceiptResult.defaultReceiptTemplateId !== newReceipt.id) fail('defaultReceiptTemplateId was not repointed');
    if (setReceiptResult.defaultTaxInvoiceTemplateId !== merchantBefore.defaultTaxInvoiceTemplateId) {
      fail('setDefault(RECEIPT) changed the TAX_INVOICE pointer');
    }
    pass('setDefault(RECEIPT) wrote defaultReceiptTemplateId, left defaultTaxInvoiceTemplateId untouched');

    // --- 2. PG callback renders the new receipt default ---------------------
    const res = await postSignedCallback(txnID);
    if (res.status !== 200) fail(`signed callback returned ${res.status}, expected 200 (is the API server running?)`);

    const order = await prisma.order.findUnique({
      where: { txnId: txnID },
      select: { bill: { select: { templateId: true, layoutSnapshot: true } } },
    });
    if (!order?.bill) fail('callback accepted but no Bill was created');
    if (order.bill.templateId !== newReceipt.id) {
      fail(`Bill.templateId = ${order.bill.templateId}, expected the new default ${newReceipt.id}`);
    }
    const snapshotTemplateId = (order.bill.layoutSnapshot as { templateId?: string } | null)?.templateId;
    if (snapshotTemplateId !== newReceipt.id) {
      fail(`Bill.layoutSnapshot.templateId = ${snapshotTemplateId}, expected ${newReceipt.id}`);
    }
    pass(`PG callback rendered the new receipt default — Bill.templateId AND Bill.layoutSnapshot.templateId = ${newReceipt.id}`);

    // --- 3. setDefault TAX_INVOICE: independent pointer --------------------
    const newTaxInvoice = await prisma.template.create({
      data: { id: uid('tpl'), merchantId: MERCHANT_ID, name: uid('TaxInvoice'), billType: 'TAX_INVOICE', layoutSchema: { ...MINIMAL_LAYOUT, skeleton: 'RETAIL' }, isHead: true },
    });
    created.push(newTaxInvoice.id);

    const setTaxResult = await templatesService.setDefault(newTaxInvoice.id, MERCHANT_ID);
    if (setTaxResult.defaultTaxInvoiceTemplateId !== newTaxInvoice.id) fail('defaultTaxInvoiceTemplateId was not repointed');
    if (setTaxResult.defaultReceiptTemplateId !== newReceipt.id) fail('setDefault(TAX_INVOICE) disturbed the RECEIPT pointer');
    pass('setDefault(TAX_INVOICE) wrote defaultTaxInvoiceTemplateId, left defaultReceiptTemplateId untouched');

    // --- 4. getDefaults resolves names ------------------------------------
    const defaults = await templatesService.getDefaults(MERCHANT_ID);
    if (defaults.receipt?.id !== newReceipt.id || defaults.taxInvoice?.id !== newTaxInvoice.id) {
      fail(`getDefaults mismatch: ${JSON.stringify(defaults)}`);
    }
    if (!defaults.receipt?.name || !defaults.taxInvoice?.name) fail('getDefaults did not resolve template names');
    pass('getDefaults() resolves both pointers to { id, name }');

    // --- 5. refusals ----------------------------------------------------
    const other = await prisma.merchant.create({ data: { id: uid('m'), jiopayMid: uid('mid'), name: 'F-6 other', secretKeyEnc: Buffer.from('x') } });
    const theirs = await prisma.template.create({
      data: { id: uid('tpl'), merchantId: other.id, name: uid('Theirs'), billType: 'RECEIPT', layoutSchema: MINIMAL_LAYOUT, isHead: true },
    });
    let crossErr: unknown;
    await templatesService.setDefault(theirs.id, MERCHANT_ID).catch((e) => (crossErr = e));
    if (!(crossErr instanceof NotFoundException)) fail('second merchant templateId did not 404');
    await prisma.template.deleteMany({ where: { merchantId: other.id } });
    await prisma.merchant.delete({ where: { id: other.id } });
    pass("a second merchant's templateId → 404");
  } finally {
    // Restore the seed merchant's pointers and remove all scratch rows.
    await prisma.merchant.update({
      where: { id: MERCHANT_ID },
      data: {
        defaultReceiptTemplateId: merchantBefore.defaultReceiptTemplateId,
        defaultTaxInvoiceTemplateId: merchantBefore.defaultTaxInvoiceTemplateId,
      },
    });
    const order = await prisma.order.findUnique({ where: { txnId: txnID }, select: { id: true } });
    if (order) {
      await prisma.broadcast.deleteMany({ where: { orderId: order.id } });
      await prisma.link.deleteMany({ where: { orderId: order.id } });
      await prisma.bill.deleteMany({ where: { orderId: order.id } });
      await prisma.order.delete({ where: { id: order.id } });
    }
    if (created.length > 0) await prisma.template.deleteMany({ where: { id: { in: created } } });

    const finalCount = await prisma.template.count();
    if (finalCount === baselineTemplateCount) {
      pass(`Template row count unchanged across the run (${finalCount})`);
    } else {
      console.error(`FAIL  Template row count drifted: ${baselineTemplateCount} -> ${finalCount}`);
    }
    await prisma.$disconnect();
  }

  console.log('\nPASS — F-6 default selection verified end-to-end (pointer write + PG-callback render-through).\n');
}

main().catch((err) => {
  console.error('\nverify-f6-default-selection failed:', err);
  process.exit(1);
});
