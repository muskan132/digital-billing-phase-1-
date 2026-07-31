const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
(async () => {
  const order = await prisma.order.findUnique({
    where: { externalTransactionId: 'fixture-2026-b3-livecheck' },
    include: { bill: true, broadcasts: true },
  });
  console.log('order.source:', order.source, 'order.billType?', order.bill?.billType);
  console.log('broadcasts:', JSON.stringify(order.broadcasts, null, 2));
  await prisma.$disconnect();
})();
