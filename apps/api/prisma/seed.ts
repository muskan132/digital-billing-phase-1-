import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomBytes } from 'crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const MERCHANT_ID = 'seed-merchant-demo';
const USER_MERCHANT_ADMIN_ID = 'seed-user-merchant-admin';
const USER_PLATFORM_ADMIN_ID = 'seed-user-platform-admin';
const TEMPLATE_RECEIPT_MINIMALIST_ID = 'seed-template-receipt';
const TEMPLATE_RECEIPT_THERMAL_ID = 'seed-template-receipt-thermal';
const TEMPLATE_TAX_INVOICE_ID = 'seed-template-tax-invoice';
const TEMPLATE_RETAIL_ID = 'seed-template-retail';
const MERCHANT_API_KEY_ID = 'seed-merchant-api-key-demo';
const DEMO_API_KEY_FILE = path.join(__dirname, '..', '.demo-api-key.local');

// Both receipt templates share this identical 6-block structure (D-10) — only
// Template.skeleton differs between them, driving CSS presentation, not content.
const RECEIPT_LAYOUT_SCHEMA = [
  { type: 'HEADER', order: 1, props: {} },
  { type: 'MERCHANT_INFO', order: 2, props: {} },
  { type: 'ITEMS', order: 3, props: {} },
  { type: 'TOTAL', order: 4, props: {} },
  { type: 'PAYMENT_DETAILS', order: 5, props: {} },
  { type: 'FOOTER', order: 6, props: {} },
];

async function main() {
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey) {
    throw new Error('SECRET_KEY env var is required to seed the merchant secret');
  }

  const merchantData = {
    jiopayMid: 'JP2000000007',
    name: 'Demo Merchant',
    secretKeyEnc: Buffer.from(secretKey, 'utf-8'),
    defaultChannel: 'EMAIL' as const,
    // Demo data only — real values will come from the merchant-onboarding system later.
    addressLine1: '221, Linking Road',
    addressLine2: 'Bandra West',
    city: 'Mumbai',
    state: 'Maharashtra',
    pincode: '400050',
    gstin: '27ABCDE1234F1Z5',
    // D-25: gstStateCode is the 2-digit GST place-of-supply code, distinct from `state`
    // (the receipt's display name, e.g. "Maharashtra") — must equal gstin[0:2].
    gstStateCode: '27',
    supportEmail: 'support@demo-merchant.test',
    supportPhone: '+91 22 4000 1234',
  };
  if (merchantData.gstStateCode !== merchantData.gstin.slice(0, 2)) {
    throw new Error(
      `Seed data error: Merchant.gstStateCode ("${merchantData.gstStateCode}") must equal gstin[0:2] ("${merchantData.gstin.slice(0, 2)}") per D-25`,
    );
  }
  await prisma.merchant.upsert({
    where: { id: MERCHANT_ID },
    create: { id: MERCHANT_ID, ...merchantData },
    update: merchantData,
  });

  await prisma.user.upsert({
    where: { id: USER_MERCHANT_ADMIN_ID },
    create: {
      id: USER_MERCHANT_ADMIN_ID,
      merchantId: MERCHANT_ID,
      type: 'EXTERNAL',
      role: 'MERCHANT_ADMIN',
      email: 'merchant-admin@demo-merchant.test',
    },
    update: {
      merchantId: MERCHANT_ID,
      type: 'EXTERNAL',
      role: 'MERCHANT_ADMIN',
      email: 'merchant-admin@demo-merchant.test',
    },
  });

  await prisma.user.upsert({
    where: { id: USER_PLATFORM_ADMIN_ID },
    create: {
      id: USER_PLATFORM_ADMIN_ID,
      merchantId: null,
      type: 'INTERNAL',
      role: 'PLATFORM_ADMIN',
      email: 'platform-admin@digitalbilling.test',
    },
    update: {
      merchantId: null,
      type: 'INTERNAL',
      role: 'PLATFORM_ADMIN',
      email: 'platform-admin@digitalbilling.test',
    },
  });

  const minimalistReceiptData = {
    merchantId: null,
    name: 'Minimalist Receipt',
    billType: 'RECEIPT' as const,
    skeleton: 'MINIMALIST' as const,
    layoutSchema: RECEIPT_LAYOUT_SCHEMA,
  };
  await prisma.template.upsert({
    where: { id: TEMPLATE_RECEIPT_MINIMALIST_ID },
    create: { id: TEMPLATE_RECEIPT_MINIMALIST_ID, ...minimalistReceiptData },
    update: minimalistReceiptData,
  });

  const thermalReceiptData = {
    merchantId: null,
    name: 'Compact Thermal Receipt',
    billType: 'RECEIPT' as const,
    skeleton: 'COMPACT_THERMAL' as const,
    layoutSchema: RECEIPT_LAYOUT_SCHEMA,
  };
  await prisma.template.upsert({
    where: { id: TEMPLATE_RECEIPT_THERMAL_ID },
    create: { id: TEMPLATE_RECEIPT_THERMAL_ID, ...thermalReceiptData },
    update: thermalReceiptData,
  });

  const taxInvoiceTemplateData = {
    merchantId: null,
    name: 'Tax Invoice (TAX_COMPLIANT)',
    billType: 'TAX_INVOICE' as const,
    skeleton: 'TAX_COMPLIANT' as const,
    // T-2: TAX_SUMMARY added to the block-type enum (D-10) and to this layout, between
    // ITEMS and TOTAL. TAX_SUMMARY renders nothing yet — the real CGST/SGST/IGST-by-rate
    // breakdown is V-5's job, once L-3 exposes items[] data to the renderer. The
    // itemized ITEMS layout itself is also still V-5's job, not this one.
    layoutSchema: [
      { type: 'HEADER', order: 1, props: {} },
      { type: 'MERCHANT_INFO', order: 2, props: {} },
      { type: 'ITEMS', order: 3, props: {} },
      { type: 'TAX_SUMMARY', order: 4, props: {} },
      { type: 'TOTAL', order: 5, props: {} },
      { type: 'FOOTER', order: 6, props: {} },
    ],
  };
  await prisma.template.upsert({
    where: { id: TEMPLATE_TAX_INVOICE_ID },
    create: { id: TEMPLATE_TAX_INVOICE_ID, ...taxInvoiceTemplateData },
    update: taxInvoiceTemplateData,
  });

  // RETAIL template — docs/TEMPLATE_SYSTEM_v2.md §4.2. billType is TAX_INVOICE (not
  // RECEIPT): it needs items[]/per-line tax data, which only a TAX_INVOICE snapshot
  // carries (BR-23). This does NOT change bills.service.ts's default-template
  // resolution: resolveTaxInvoiceTemplate() falls back to the oldest shared
  // TAX_INVOICE template (createdAt asc) when no template_id is given, and this row is
  // seeded after seed-template-tax-invoice, so existing callers are unaffected. A
  // caller gets this template only by passing template_id explicitly.
  const retailTemplateData = {
    merchantId: null,
    name: 'Retail Bill (RETAIL)',
    billType: 'TAX_INVOICE' as const,
    skeleton: 'RETAIL' as const,
    layoutSchema: [
      { type: 'HEADER', order: 1, props: {} },
      { type: 'MERCHANT_INFO', order: 2, props: {} },
      {
        type: 'ITEMS',
        order: 3,
        props: {
          // §2/§9's column-config contract: field is the immutable data binding,
          // label/visible/align are presentation. RATE is declared but not visible —
          // today's design shows name x qty inline + amount right-aligned, HSN as a
          // muted secondary line — so a future builder can toggle RATE on with no
          // renderer change.
          columns: [
            { field: 'name', label: 'ITEM', visible: true, align: 'left' },
            { field: 'quantity', label: 'QTY', visible: true, align: 'left' },
            { field: 'unitPricePaise', label: 'RATE', visible: false, align: 'right' },
            { field: 'amountPaise', label: 'AMOUNT', visible: true, align: 'right' },
          ],
          secondaryFields: ['hsn'],
        },
      },
      // §3: TOTAL is the pre-tax total, shown before the tax ladder — basis:'pre_tax'
      // opts into that computation (subtotalPaise - discountPaise). AMOUNT_PAYABLE
      // below is the distinct post-tax hero total.
      { type: 'TOTAL', order: 4, props: { basis: 'pre_tax' } },
      // No data source yet (Bill.snapshot carries no savings figure) — renders nothing
      // until a future task adds one. See memory: project_tax_compliant_known_bugs.md
      // is NOT this — this is a tracked, expected gap, not a bug.
      { type: 'SAVINGS', order: 5, props: {} },
      // mode:'auto' opts into the corrected §5 component-row rendering (never the
      // legacy CGST/SGST-as-columns matrix TAX_COMPLIANT still uses).
      { type: 'TAX_SUMMARY', order: 6, props: { mode: 'auto' } },
      { type: 'AMOUNT_PAYABLE', order: 7, props: {} },
      // No data source yet — same as SAVINGS.
      { type: 'LOYALTY', order: 8, props: {} },
      // Template-authored demo copy — real content today, not bill-computed.
      {
        type: 'COUPON',
        order: 9,
        props: {
          headline: 'Get 10% off your next visit',
          code: 'RETAIL10',
          validity: 'Valid for 30 days',
          ctaLabel: 'Show this code at checkout',
        },
      },
      {
        type: 'SURVEY',
        order: 10,
        props: {
          prompt: 'How was your shopping experience today?',
          type: 'rating',
          url: 'https://example.test/survey',
        },
      },
      { type: 'FOOTER', order: 11, props: {} },
    ],
  };
  await prisma.template.upsert({
    where: { id: TEMPLATE_RETAIL_ID },
    create: { id: TEMPLATE_RETAIL_ID, ...retailTemplateData },
    update: retailTemplateData,
  });

  await prisma.merchant.update({
    where: { id: MERCHANT_ID },
    data: { defaultTemplateId: TEMPLATE_RECEIPT_MINIMALIST_ID },
  });

  // D-19: MerchantApiKey — keyPrefix plaintext for lookup, keyHash = SHA-256 of the full
  // key. Written once: if this row already exists, the plaintext is gone for good (by
  // design — it's never stored), so we skip regeneration rather than silently rotating
  // a key every reseed and invalidating whatever the demo/test setup already has.
  const existingApiKey = await prisma.merchantApiKey.findUnique({ where: { id: MERCHANT_API_KEY_ID } });
  if (existingApiKey) {
    console.log('MerchantApiKey already provisioned — skipping (plaintext was written once, on first seed).');
  } else {
    const plaintextKey = randomBytes(32).toString('hex');
    const keyPrefix = plaintextKey.slice(0, 8);
    const keyHash = createHash('sha256').update(plaintextKey).digest();

    await prisma.merchantApiKey.create({
      data: {
        id: MERCHANT_API_KEY_ID,
        merchantId: MERCHANT_ID,
        keyPrefix,
        keyHash,
        status: 'ACTIVE',
      },
    });

    fs.writeFileSync(DEMO_API_KEY_FILE, plaintextKey + '\n', { mode: 0o600 });
    console.log(`MerchantApiKey provisioned — plaintext written to ${DEMO_API_KEY_FILE} (gitignored, never logged).`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async () => {
    await prisma.$disconnect();
    console.error('Seed failed. See server/db logs for details (payload withheld to avoid leaking secrets).');
    process.exit(1);
  });
