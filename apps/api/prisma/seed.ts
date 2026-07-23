import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const MERCHANT_ID = 'seed-merchant-demo';
const USER_MERCHANT_ADMIN_ID = 'seed-user-merchant-admin';
const USER_PLATFORM_ADMIN_ID = 'seed-user-platform-admin';
const TEMPLATE_RECEIPT_MINIMALIST_ID = 'seed-template-receipt';
const TEMPLATE_RECEIPT_THERMAL_ID = 'seed-template-receipt-thermal';
const TEMPLATE_TAX_INVOICE_ID = 'seed-template-tax-invoice';

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
    supportEmail: 'support@demo-merchant.test',
    supportPhone: '+91 22 4000 1234',
  };
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
    name: 'Default Tax Invoice',
    billType: 'TAX_INVOICE' as const,
    // Unreachable in v1 (D-13) — skeleton value is a placeholder, never rendered.
    skeleton: 'MINIMALIST' as const,
    layoutSchema: [
      { type: 'HEADER', order: 1, props: {} },
      { type: 'MERCHANT_INFO', order: 2, props: {} },
      { type: 'ITEMS', order: 3, props: {} },
      { type: 'TOTAL', order: 4, props: {} },
      { type: 'FOOTER', order: 5, props: {} },
    ],
  };
  await prisma.template.upsert({
    where: { id: TEMPLATE_TAX_INVOICE_ID },
    create: { id: TEMPLATE_TAX_INVOICE_ID, ...taxInvoiceTemplateData },
    update: taxInvoiceTemplateData,
  });

  await prisma.merchant.update({
    where: { id: MERCHANT_ID },
    data: { defaultTemplateId: TEMPLATE_RECEIPT_MINIMALIST_ID },
  });
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
