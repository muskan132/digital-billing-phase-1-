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

  async persist(callback: JioPayCallbackDto): Promise<void> {
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

    const amountPaise = rupeesToPaise(callback.amount ?? '');
    const idempotencyKey = `PG:${callback.merchantTxnNo}#${callback.paymentID}`;

    const orderFields = {
      merchantId: merchant.id,
      idempotencyKey,
      merchantTxnNo: callback.merchantTxnNo ?? '',
      paymentId: callback.paymentID ?? '',
      txnId,
      amountPaise,
      currency: 'INR',
      responseCode: callback.responseCode ?? '',
      paymentMode: callback.paymentMode,
      paymentDateTime: callback.paymentDateTime,
      customerMobile_pii: callback.customerMobileNo,
      customerEmail_pii: callback.customerEmailID,
      rawCallback: JSON.parse(JSON.stringify(callback)) as Prisma.InputJsonValue,
    };

    if (callback.responseCode !== SUCCESS_RESPONSE_CODE) {
      await this.prisma.order.upsert({
        where: { txnId },
        create: { ...orderFields, status: 'NON_SUCCESS' },
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
        create: { ...orderFields, status: 'SUCCESS' },
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
