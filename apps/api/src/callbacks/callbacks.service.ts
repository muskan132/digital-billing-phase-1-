import { Injectable, Logger } from '@nestjs/common';
import { Channel, Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { JioPayCallbackDto } from './jiopay-callback.dto';
import { rupeesToPaise } from '../common/money.util';
import { generateIdentifier } from '../common/link-id.util';
import { maskEmail, maskMobile } from '../common/mask.util';

const SUCCESS_RESPONSE_CODE = '0000';

@Injectable()
export class CallbacksService {
  private readonly logger = new Logger(CallbacksService.name);

  constructor(private readonly prisma: PrismaService) {}

  async persist(callback: JioPayCallbackDto, rawBody: unknown): Promise<void> {
    const txnId = callback.txnID;
    if (!txnId) {
      this.logger.warn('txnId absent — malformed callback, not persisted');
      return;
    }

    const merchant = await this.prisma.merchant.findUnique({
      where: { jiopayMid: callback.merchantId },
      include: { defaultTemplate: true },
    });
    if (!merchant) {
      this.logger.warn('Unknown merchantId — not persisted');
      return;
    }

    const idempotencyKey =
      callback.merchantTxnNo && callback.paymentID
        ? `PG:${callback.merchantTxnNo}#${callback.paymentID}`
        : null;

    const orderFields = {
      merchantId: merchant.id,
      idempotencyKey,
      merchantTxnNo: callback.merchantTxnNo ?? '',
      paymentId: callback.paymentID ?? '',
      txnId,
      currency: 'INR',
      responseCode: callback.responseCode ?? '',
      paymentMode: callback.paymentMode,
      paymentDateTime: callback.paymentDateTime,
      customerMobile_pii: callback.customerMobileNo,
      customerEmail_pii: callback.customerEmailID,
      rawCallback: rawBody as Prisma.InputJsonValue,
    };

    if (callback.responseCode !== SUCCESS_RESPONSE_CODE) {
      await this.prisma.order.upsert({
        where: { txnId },
        create: { ...orderFields, status: 'NON_SUCCESS', amountPaise: null },
        update: {},
      });
      return;
    }

    let amountPaise: bigint;
    try {
      amountPaise = rupeesToPaise(callback.amount ?? '');
    } catch {
      this.logger.warn(
        `txnId=${txnId} — 0000 callback with unparseable amount, config/contract error — ` +
          `committing Order(status=SUCCESS, amountPaise=null), skipping Bill/Link/Broadcast`,
      );
      await this.prisma.order.upsert({
        where: { txnId },
        create: { ...orderFields, status: 'SUCCESS', amountPaise: null },
        update: {},
      });
      return;
    }

    if (!merchant.defaultTemplate) {
      this.logger.warn(
        `Merchant ${merchant.id} has no defaultTemplate configured — committing Order only (config error)`,
      );
      await this.prisma.order.upsert({
        where: { txnId },
        create: { ...orderFields, status: 'SUCCESS', amountPaise },
        update: {},
      });
      return;
    }

    const recipient = merchant.defaultChannel === Channel.EMAIL ? callback.customerEmailID : callback.customerMobileNo;

    if (!recipient) {
      this.logger.warn(
        `mobile=${maskMobile(callback.customerMobileNo)} email=${maskEmail(callback.customerEmailID)} — ` +
          `no recipient for channel ${merchant.defaultChannel}, committing Order/Bill/Link without a Broadcast`,
      );
    }

    await this.prisma.order.upsert({
      where: { txnId },
      create: {
        ...orderFields,
        status: 'SUCCESS',
        amountPaise,
        bill: {
          create: {
            billType: merchant.defaultTemplate.billType,
            templateId: merchant.defaultTemplate.id,
            totalPaise: amountPaise,
            currency: 'INR',
            snapshot: {
              merchantName: merchant.name,
              amountPaise: amountPaise.toString(),
              currency: 'INR',
              paymentMode: callback.paymentMode ?? null,
              paymentDateTime: callback.paymentDateTime ?? null,
              receiptNumber: callback.txnID ?? null,
              merchantTxnNo: callback.merchantTxnNo ?? null,
              cardNetwork: callback.cardNetwork ?? null,
              // D-17: paymentInstId is only known to be pre-masked by JioPay for card
              // transactions (e.g. "4XXX XXXX XXXX 1111") — for other payment modes
              // (e.g. UPI) this field may carry the customer's VPA, which is personal
              // data. Only include it when cardNetwork confirms a card transaction;
              // otherwise store null rather than risk leaking identifying data to the
              // public bill-view page.
              paymentInstId: callback.cardNetwork ? (callback.paymentInstId ?? null) : null,
              respDescription: callback.respDescription ?? null,
            },
          },
        },
        link: {
          create: {
            identifier: generateIdentifier(),
          },
        },
        ...(recipient
          ? {
              broadcasts: {
                create: [
                  {
                    channel: merchant.defaultChannel,
                    recipient,
                    status: 'PENDING',
                  },
                ],
              },
            }
          : {}),
      },
      update: {},
    });
  }
}
