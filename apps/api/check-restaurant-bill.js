const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const order = await prisma.order.findUnique({
    where: { externalTransactionId: 'fixture-2026-restaurant' },
    include: { bill: true, link: true },
  });
  if (!order) {
    console.log('No order found for fixture-2026-restaurant');
  } else {
    console.log('identifier:', order.link?.identifier);
    console.log('layoutSnapshot:', JSON.stringify(order.bill?.layoutSnapshot, null, 2));
  }
  await prisma.$disconnect();
})();
