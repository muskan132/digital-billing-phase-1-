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
          defaultReceiptTemplate: {
            id: 'template_1',
            billType: 'RECEIPT',
            skeleton: 'MINIMALIST',
            // D-96: the real shape since T-5's migration — a v2 envelope, not
            // a bare array.
            layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [{ type: 'HEADER', order: 1, props: {} }] },
            version: 1,
          },
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

  // TEMPLATE_SYSTEM_v2 §7: the resolved defaultReceiptTemplate's render spec must be frozen
  // onto the bill at creation, independent of the live Template row afterward.
  it('freezes the resolved defaultReceiptTemplate render spec into Bill.layoutSnapshot', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const defaultReceiptTemplate = {
      id: 'template_1',
      billType: 'RECEIPT',
      skeleton: 'MINIMALIST',
      // D-96: the real shape since T-5's migration — a v2 envelope, not a
      // bare array. The BLOCKS constant below is what should end up in
      // layoutSnapshot.blocks — the extracted array, not the whole envelope.
      layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [{ type: 'HEADER', order: 1, props: {} }] },
      version: 1,
    };
    const prisma = {
      merchant: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'merchant_1',
          name: 'Test Merchant',
          defaultChannel: 'EMAIL',
          defaultReceiptTemplate,
        }),
      },
      order: { upsert },
    } as unknown as PrismaService;

    const service = new CallbacksService(prisma);

    const callback: JioPayCallbackDto = {
      txnID: 'txn_3',
      merchantId: 'JP2000000007',
      responseCode: '0000',
      amount: '1.00',
      merchantTxnNo: 'mtxn_3',
      paymentID: 'pay_3',
      paymentMode: 'UPI',
      paymentDateTime: '20260717120000',
      customerEmailID: 'customer@example.com',
    };

    await service.persist(callback, { raw: true });

    const layoutSnapshot = upsert.mock.calls[0][0].create.bill.create.layoutSnapshot;
    // D-96 regression check: .blocks must be the plain array extracted from
    // the v2 envelope, never the whole envelope object.
    expect(Array.isArray(layoutSnapshot.blocks)).toBe(true);
    expect(layoutSnapshot).toEqual({
      schemaVersion: 1,
      skeleton: defaultReceiptTemplate.skeleton,
      blocks: defaultReceiptTemplate.layoutSchema.blocks,
      templateId: defaultReceiptTemplate.id,
      templateVersion: defaultReceiptTemplate.version,
    });
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
          defaultReceiptTemplate: {
            id: 'template_1',
            billType: 'RECEIPT',
            skeleton: 'MINIMALIST',
            layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [{ type: 'HEADER', order: 1, props: {} }] },
            version: 1,
          },
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

// N-1 / D-83: Order.saleAt is derived from paymentDateTime via the single
// orderFields object spread into every Order.upsert create branch below.
describe('CallbacksService.persist — Order.saleAt (N-1 / D-83)', () => {
  function makePrisma(upsert: jest.Mock, defaultReceiptTemplate: unknown = {
    id: 'template_1',
    billType: 'RECEIPT',
    skeleton: 'MINIMALIST',
    layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [{ type: 'HEADER', order: 1, props: {} }] },
    version: 1,
  }) {
    return {
      merchant: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'merchant_1',
          name: 'Test Merchant',
          defaultChannel: 'EMAIL',
          defaultReceiptTemplate,
        }),
      },
      order: { upsert },
    } as unknown as PrismaService;
  }

  it('a full-SUCCESS callback sets Order.saleAt from a valid paymentDateTime, paymentDateTime itself untouched', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const service = new CallbacksService(makePrisma(upsert));

    const callback: JioPayCallbackDto = {
      txnID: 'txn_saleat_1',
      merchantId: 'JP2000000007',
      responseCode: '0000',
      amount: '1.00',
      merchantTxnNo: 'mtxn_saleat_1',
      paymentID: 'pay_saleat_1',
      paymentMode: 'UPI',
      paymentDateTime: '20260916140000',
      customerEmailID: 'customer@example.com',
    };

    await service.persist(callback, { raw: true });

    const create = upsert.mock.calls[0][0].create;
    expect(create.paymentDateTime).toBe('20260916140000');
    expect(create.saleAt).toEqual(new Date('2026-09-16T08:30:00.000Z'));
  });

  it('an unparseable paymentDateTime yields Order.saleAt = null on the full-SUCCESS branch, not a coerced date', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const service = new CallbacksService(makePrisma(upsert));

    const callback: JioPayCallbackDto = {
      txnID: 'txn_saleat_2',
      merchantId: 'JP2000000007',
      responseCode: '0000',
      amount: '1.00',
      merchantTxnNo: 'mtxn_saleat_2',
      paymentID: 'pay_saleat_2',
      paymentMode: 'UPI',
      paymentDateTime: 'not-a-date',
      customerEmailID: 'customer@example.com',
    };

    await service.persist(callback, { raw: true });

    expect(upsert.mock.calls[0][0].create.saleAt).toBeNull();
  });

  it('the NON_SUCCESS branch also sets Order.saleAt (orderFields is shared across every create branch)', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const service = new CallbacksService(makePrisma(upsert));

    const callback: JioPayCallbackDto = {
      txnID: 'txn_saleat_3',
      merchantId: 'JP2000000007',
      responseCode: '1111', // non-success
      paymentDateTime: '20260916140000',
    };

    await service.persist(callback, { raw: true });

    expect(upsert.mock.calls[0][0].create.status).toBe('NON_SUCCESS');
    expect(upsert.mock.calls[0][0].create.saleAt).toEqual(new Date('2026-09-16T08:30:00.000Z'));
  });

  it('the SUCCESS-with-unparseable-amount branch also sets Order.saleAt', async () => {
    const upsert = jest.fn().mockResolvedValue(undefined);
    const service = new CallbacksService(makePrisma(upsert));

    const callback: JioPayCallbackDto = {
      txnID: 'txn_saleat_4',
      merchantId: 'JP2000000007',
      responseCode: '0000',
      amount: 'not-a-rupee-amount',
      paymentDateTime: '20260916140000',
    };

    await service.persist(callback, { raw: true });

    expect(upsert.mock.calls[0][0].create.status).toBe('SUCCESS');
    expect(upsert.mock.calls[0][0].create.amountPaise).toBeNull();
    expect(upsert.mock.calls[0][0].create.saleAt).toEqual(new Date('2026-09-16T08:30:00.000Z'));
  });
});
