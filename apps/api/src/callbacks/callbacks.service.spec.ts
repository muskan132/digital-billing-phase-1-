import { CallbacksService } from './callbacks.service';
import { PrismaService } from '../prisma/prisma.service';
import { JioPayCallbackDto } from './jiopay-callback.dto';

describe('CallbacksService.persist — Bill.snapshot whitelist', () => {
  // D-17: Bill.snapshot is a whitelisted, non-PII projection. L-2's Prisma `select`
  // cannot filter fields inside this JSON column, so the only guard against a future
  // PII field silently entering the public bill-view payload is this exact key-set
  // assertion on what P-1 writes. Adding a field here must fail this test first.
  it('writes exactly the whitelisted key set into Bill.snapshot on a successful callback', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      merchant: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'merchant_1',
          name: 'Test Merchant',
          defaultChannel: 'EMAIL',
          defaultTemplate: { id: 'template_1', billType: 'RECEIPT' },
        }),
      },
      order: { upsert },
    } as unknown as PrismaService;

    const service = new CallbacksService(prisma);

    const callback: JioPayCallbackDto = {
      txnID: 'txn_1',
      merchantId: 'JP2000000007',
      responseCode: '0000',
      amount: '1.00',
      merchantTxnNo: 'mtxn_1',
      paymentID: 'pay_1',
      paymentMode: 'UPI',
      paymentDateTime: '20260717120000',
      customerEmailID: 'customer@example.com',
    };

    await service.persist(callback, { raw: true });

    expect(upsert).toHaveBeenCalledTimes(1);
    const snapshot = upsert.mock.calls[0][0].create.bill.create.snapshot;

    expect(Object.keys(snapshot).sort()).toEqual(
      [
        'amountPaise',
        'currency',
        'merchantName',
        'paymentDateTime',
        'paymentMode',
        'receiptNumber',
        'merchantTxnNo',
        'cardNetwork',
        'paymentInstId',
        'respDescription',
      ].sort(),
    );
  });

  // D-17: paymentInstId is only known-masked by JioPay for card transactions — for
  // other payment modes (e.g. UPI) it may carry a customer VPA, which is PII. It must
  // never be included unless cardNetwork confirms a card transaction.
  it('nulls out paymentInstId when cardNetwork is absent (non-card payment mode)', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const prisma = {
      merchant: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'merchant_1',
          name: 'Test Merchant',
          defaultChannel: 'EMAIL',
          defaultTemplate: { id: 'template_1', billType: 'RECEIPT' },
        }),
      },
      order: { upsert },
    } as unknown as PrismaService;

    const service = new CallbacksService(prisma);

    const callback: JioPayCallbackDto = {
      txnID: 'txn_2',
      merchantId: 'JP2000000007',
      responseCode: '0000',
      amount: '1.00',
      merchantTxnNo: 'mtxn_2',
      paymentID: 'pay_2',
      paymentMode: 'UPI',
      paymentDateTime: '20260717120000',
      customerEmailID: 'customer@example.com',
      paymentInstId: '9876543210@paytm',
      // cardNetwork intentionally absent — non-card payment mode
    };

    await service.persist(callback, { raw: true });

    const snapshot = upsert.mock.calls[0][0].create.bill.create.snapshot;
    expect(snapshot.paymentInstId).toBeNull();
  });
});
