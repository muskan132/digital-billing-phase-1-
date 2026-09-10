// F-7 — direct-API template resolution contract (D-61 / D-77). Real DB, real
// BillsService. Proves, against the SEEDED merchant (so the F-7 seed change is
// exercised too):
//   1. a visible RECEIPT template_id -> 422 TEMPLATE_BILL_TYPE_MISMATCH with
//      ZERO rows across Order/Bill/Link/Broadcast/OrderItem (real count()).
//   2. another merchant's real template_id -> the same fallback as unknown,
//      never a 403, never their template rendered.
//   3. an unknown id -> 201, default used, template_fallback stated.
//   4. no template_id -> the seeded default, no template_fallback.
//   5. the D-27 replay path (200 on repeat) unchanged.
//   6. the positional oldest-by-row-age chain appears nowhere in bills.service.ts.
//
// Usage: pnpm --filter @digital-billing/api verify:f7   (docker compose up; no API server needed)

import * as path from 'path';
import * as fs from 'fs';
import { config } from 'dotenv';
import { UnprocessableEntityException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { BillsService } from '../src/bills/bills.service';
import { CreateBillDto } from '../src/bills/dto/create-bill.dto';

config({ path: path.join(__dirname, '..', '.env') });

const SEED_MERCHANT_ID = 'seed-merchant-demo';
const SEED_TAX_TEMPLATE_ID = 'seed-template-tax-invoice';

const prisma = new PrismaClient();
const service = new BillsService(new PrismaService());

let counter = 0;
const uid = (p: string) => `f7-verify-${p}-${Date.now()}-${++counter}`;

function fail(msg: string): never {
  throw new Error(`FAIL — ${msg}`);
}
function pass(msg: string): void {
  console.log(`PASS  ${msg}`);
}

function dto(overrides: Partial<CreateBillDto> = {}): CreateBillDto {
  return {
    external_transaction_id: uid('ext'),
    invoice_number: uid('INV'),
    place_of_supply: '27',
    currency: 'INR',
    sale_at: '2026-09-10T10:00:00Z',
    line_items: [
      { line_no: 1, name: 'Widget', hsn: '1234', uom: 'NOS', quantity: 1, unit_price_paise: '100', item_discount_paise: '0', tax_rate_bp: 700, tax_paise: '7', cgst_paise: '4', sgst_paise: '3', igst_paise: '0' },
    ],
    totals: { subtotal_paise: '100', bill_discount_paise: '0', discount_paise: '0', tax_paise: '7', total_paise: '107' },
    tax_block: { cgst_paise: '4', sgst_paise: '3', igst_paise: '0' },
    ...overrides,
  };
}

async function seedCounts() {
  return {
    order: await prisma.order.count({ where: { merchantId: SEED_MERCHANT_ID } }),
    bill: await prisma.bill.count({ where: { merchantId: SEED_MERCHANT_ID } }),
    orderItem: await prisma.orderItem.count(),
    link: await prisma.link.count(),
    broadcast: await prisma.broadcast.count(),
  };
}

async function deleteOrderByExt(ext: string) {
  const order = await prisma.order.findUnique({ where: { externalTransactionId: ext }, select: { id: true } });
  if (!order) return;
  await prisma.broadcast.deleteMany({ where: { orderId: order.id } });
  await prisma.link.deleteMany({ where: { orderId: order.id } });
  await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
  await prisma.bill.deleteMany({ where: { orderId: order.id } });
  await prisma.order.delete({ where: { id: order.id } });
}

async function main() {
  console.log('\n=== verify-f7-direct-api-resolution ===\n');

  // Confirm the F-7 seed change landed.
  const seedMerchant = await prisma.merchant.findUniqueOrThrow({
    where: { id: SEED_MERCHANT_ID },
    select: { defaultTaxInvoiceTemplateId: true },
  });
  if (seedMerchant.defaultTaxInvoiceTemplateId !== SEED_TAX_TEMPLATE_ID) {
    fail(`seed merchant defaultTaxInvoiceTemplateId=${seedMerchant.defaultTaxInvoiceTemplateId}, expected ${SEED_TAX_TEMPLATE_ID} — run pnpm prisma db seed`);
  }
  pass(`seed merchant defaultTaxInvoiceTemplateId = ${SEED_TAX_TEMPLATE_ID} (F-7 seed change present)`);

  const createdExts: string[] = [];
  const scratchTemplateIds: string[] = [];
  let otherMerchantId: string | null = null;

  try {
    // --- 1. RECEIPT template_id -> 422, zero writes ------------------------
    const receiptTpl = await prisma.template.create({
      data: { id: uid('tpl-rcpt'), merchantId: SEED_MERCHANT_ID, name: uid('Receipt'), billType: 'RECEIPT', layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] }, isHead: true },
    });
    scratchTemplateIds.push(receiptTpl.id);

    const before = await seedCounts();
    const d1 = dto({ template_id: receiptTpl.id });
    const err = await service.createBill(d1, SEED_MERCHANT_ID).catch((e: unknown) => e);
    if (!(err instanceof UnprocessableEntityException)) fail('RECEIPT template_id did not throw UnprocessableEntityException');
    const code = (err.getResponse() as { error_code?: string }).error_code;
    if (code !== 'TEMPLATE_BILL_TYPE_MISMATCH') fail(`expected TEMPLATE_BILL_TYPE_MISMATCH, got ${code}`);
    const after = await seedCounts();
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      fail(`RECEIPT template_id wrote rows: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    }
    pass('RECEIPT template_id → 422 TEMPLATE_BILL_TYPE_MISMATCH, ZERO rows across Order/Bill/Link/Broadcast/OrderItem');

    // --- 2. another merchant's template_id -> same fallback --------------
    otherMerchantId = uid('m-other');
    await prisma.merchant.create({ data: { id: otherMerchantId, jiopayMid: uid('mid'), name: 'F-7 other', secretKeyEnc: Buffer.from('x') } });
    const theirTpl = await prisma.template.create({
      data: { id: uid('tpl-theirs'), merchantId: otherMerchantId, name: uid('Theirs'), billType: 'TAX_INVOICE', layoutSchema: { schemaVersion: 2, skeleton: 'TAX_COMPLIANT', blocks: [] }, isHead: true },
    });

    const d2 = dto({ template_id: theirTpl.id });
    createdExts.push(d2.external_transaction_id);
    const r2 = await service.createBill(d2, SEED_MERCHANT_ID);
    if (!r2.created) fail('cross-merchant call did not create a bill');
    if (r2.body.template_id_used === theirTpl.id) fail("cross-merchant call rendered the OTHER merchant's template");
    if (r2.body.template_id_used !== SEED_TAX_TEMPLATE_ID) fail(`cross-merchant fallback used ${r2.body.template_id_used}, expected the seed default`);
    if (r2.body.template_fallback?.reason !== 'TEMPLATE_ID_NOT_FOUND' || r2.body.template_fallback?.requested_template_id !== theirTpl.id) {
      fail(`cross-merchant template_fallback wrong: ${JSON.stringify(r2.body.template_fallback)}`);
    }
    const bill2 = await prisma.bill.findUniqueOrThrow({ where: { id: r2.body.bill_id }, select: { templateId: true } });
    if (bill2.templateId !== SEED_TAX_TEMPLATE_ID) fail(`Bill.templateId=${bill2.templateId}, expected the seed default`);
    pass("another merchant's template_id → same fallback as unknown, never a 403, never their template (Bill.templateId = seed default)");

    // --- 3. unknown id -> 201 + fallback --------------------------------
    const d3 = dto({ template_id: 'totally-made-up-id' });
    createdExts.push(d3.external_transaction_id);
    const r3 = await service.createBill(d3, SEED_MERCHANT_ID);
    if (!r3.created || r3.body.template_id_used !== SEED_TAX_TEMPLATE_ID) fail('unknown id did not fall back to the default');
    if (r3.body.template_fallback?.requested_template_id !== 'totally-made-up-id') fail('unknown id: template_fallback not stated');
    pass('unknown template_id → 201, default used, template_fallback stated in the body');

    // --- 4. no template_id -> default, no fallback ---------------------
    const d4 = dto();
    createdExts.push(d4.external_transaction_id);
    const r4 = await service.createBill(d4, SEED_MERCHANT_ID);
    if (r4.body.template_id_used !== SEED_TAX_TEMPLATE_ID) fail('no template_id did not use the default');
    if ('template_fallback' in r4.body) fail('no template_id should carry NO template_fallback key');
    pass('no template_id → seeded default used, no template_fallback key');

    // --- 5. D-27 replay unchanged -------------------------------------
    const countsBeforeReplay = await seedCounts();
    const r5 = await service.createBill(d3, SEED_MERCHANT_ID); // same ext as #3
    if (r5.created) fail('replay reported created:true');
    if (r5.body.bill_id !== r3.body.bill_id) fail('replay returned a different bill');
    if ('template_fallback' in r5.body) fail('replay body carried template_fallback (should be omitted, D-77)');
    const countsAfterReplay = await seedCounts();
    if (JSON.stringify(countsAfterReplay) !== JSON.stringify(countsBeforeReplay)) fail('replay wrote rows');
    pass('D-27 replay (200 on repeated external_transaction_id) unchanged — no new rows, template_fallback omitted');

    // --- 6. grep-clean ---------------------------------------------
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'bills', 'bills.service.ts'), 'utf8');
    for (const pattern of [/orderBy:\s*\{\s*createdAt/, /merchantSpecific/, /oldest/i]) {
      if (pattern.test(src)) fail(`bills.service.ts still contains ${pattern}`);
    }
    pass('bills.service.ts is grep-clean of the positional fallback chain (no createdAt scan, no merchantSpecific, no "oldest")');
  } finally {
    for (const ext of createdExts) await deleteOrderByExt(ext);
    if (scratchTemplateIds.length) await prisma.template.deleteMany({ where: { id: { in: scratchTemplateIds } } });
    if (otherMerchantId) {
      await prisma.template.deleteMany({ where: { merchantId: otherMerchantId } });
      await prisma.merchant.deleteMany({ where: { id: otherMerchantId } });
    }
    await prisma.$disconnect();
  }

  console.log('\nPASS — F-7 direct-API resolution contract verified end-to-end.\n');
}

main().catch((err) => {
  console.error('\nverify-f7-direct-api-resolution failed:', err);
  process.exit(1);
});
