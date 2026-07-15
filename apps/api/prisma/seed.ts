import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const secretKey = process.env.SECRET_KEY;
  if (!secretKey) {
    throw new Error('SECRET_KEY env var is required to seed the merchant secret');
  }

  const merchant = await prisma.merchant.create({
    data: {
      jiopayMid: 'JP2000000007',
      name: 'Demo Merchant',
      secretKeyEnc: Buffer.from(secretKey, 'utf-8'),
      defaultChannel: 'EMAIL',
    },
  });

  await prisma.user.createMany({
    data: [
      {
        merchantId: merchant.id,
        type: 'EXTERNAL',
        role: 'MERCHANT_ADMIN',
        email: 'merchant-admin@demo-merchant.test',
      },
      {
        merchantId: null,
        type: 'INTERNAL',
        role: 'PLATFORM_ADMIN',
        email: 'platform-admin@digitalbilling.test',
      },
    ],
  });

  const receiptTemplate = await prisma.template.create({
    data: {
      merchantId: null,
      name: 'Default Receipt',
      billType: 'RECEIPT',
      layoutSchema: [
        { type: 'HEADER', order: 1, props: {} },
        { type: 'MERCHANT_INFO', order: 2, props: {} },
        { type: 'ITEMS', order: 3, props: {} },
        { type: 'TOTAL', order: 4, props: {} },
        { type: 'FOOTER', order: 5, props: {} },
      ],
    },
  });

  await prisma.template.create({
    data: {
      merchantId: null,
      name: 'Default Tax Invoice',
      billType: 'TAX_INVOICE',
      layoutSchema: [
        { type: 'HEADER', order: 1, props: {} },
        { type: 'MERCHANT_INFO', order: 2, props: {} },
        { type: 'ITEMS', order: 3, props: {} },
        { type: 'TOTAL', order: 4, props: {} },
        { type: 'FOOTER', order: 5, props: {} },
      ],
    },
  });

  await prisma.merchant.update({
    where: { id: merchant.id },
    data: { defaultTemplateId: receiptTemplate.id },
  });
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    await prisma.$disconnect();
    throw e;
  });
