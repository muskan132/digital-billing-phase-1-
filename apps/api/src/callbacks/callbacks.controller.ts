import { Body, Controller, HttpCode, Logger, Post, UseGuards } from '@nestjs/common';
import { JioPayCallbackDto } from './jiopay-callback.dto';
import { maskEmail, maskMobile } from '../common/mask.util';
import { SecureHashGuard } from './secure-hash.guard';
import { CallbacksService } from './callbacks.service';

@Controller('v1/callbacks/pg')
export class CallbacksController {
  private readonly logger = new Logger(CallbacksController.name);

  constructor(private readonly callbacksService: CallbacksService) {}

  @Post()
  @HttpCode(200)
  @UseGuards(SecureHashGuard)
  async receive(@Body() callback: JioPayCallbackDto) {
    this.logger.log(
      `Received callback: merchantTxnNo=${callback.merchantTxnNo ?? '(absent)'} ` +
        `txnID=${callback.txnID ?? '(absent)'} responseCode=${callback.responseCode ?? '(absent)'} ` +
        `mobile=${maskMobile(callback.customerMobileNo)} email=${maskEmail(callback.customerEmailID)}`,
    );
    await this.callbacksService.persist(callback);
    return { received: true };
  }
}
