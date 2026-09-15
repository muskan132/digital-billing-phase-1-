// Q-2 (D-94): real-Postgres, real-Nest-app coverage for the PII-scrubbing
// exception filter. Two proofs matter most:
//   1. A live-triggered Prisma error carrying a REAL mobile and email —
//      through the actual CallbacksService.persist() path, same technique
//      used to confirm the leak live before writing any code — produces a
//      logged message AND stack containing neither, checked at the
//      substring level (not just field-absence).
//   2. The client-visible response is byte-identical to what
//      BaseExceptionFilter produces today for a non-HttpException (500,
//      the hardcoded generic body) — confirmed against the actual
//      @nestjs/core source, not assumed.
// Plus the P2010 nested-meta.message vector, and a control case proving an
// unrelated, PII-free Prisma error still logs its real message unscrubbed
// (i.e. the filter doesn't over-redact everything into mush).
import { Controller, Get, Logger, Module, Query } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { PrismaClient, Prisma } from '@prisma/client';
import { PrismaPiiScrubFilter } from './prisma-pii.filter';
import { CallbacksService } from '../callbacks/callbacks.service';
import { PrismaService } from '../prisma/prisma.service';
import { JioPayCallbackDto } from '../callbacks/jiopay-callback.dto';

const prisma = new PrismaClient();
let counter = 0;
const uid = (p: string) => `q2-itest-${p}-${Date.now()}-${++counter}`;

const MOBILE = '9876543210';
const EMAIL = 'realcustomer@example.com';

@Controller('test')
class ProbeController {
  // Triggers a genuine PrismaClientValidationError from inside the REAL
  // CallbacksService.persist() nested-create upsert, with a real mobile and
  // email in the payload — same technique used live during planning.
  @Get('trigger-validation-error')
  async triggerValidationError(@Query('merchantId') merchantId: string, @Query('jiopayMid') jiopayMid: string) {
    const merchantWithBadTemplate = await prisma.merchant.findUniqueOrThrow({
      where: { id: merchantId },
      include: { defaultReceiptTemplate: true },
    });
    (merchantWithBadTemplate as unknown as { defaultReceiptTemplate: { billType: string } }).defaultReceiptTemplate.billType =
      'NOT_A_REAL_BILLTYPE';

    const prismaService = {
      merchant: { findUnique: async () => merchantWithBadTemplate },
      order: prisma.order,
    } as unknown as PrismaService;

    const service = new CallbacksService(prismaService);
    const callback: JioPayCallbackDto = {
      txnID: uid('validation'),
      merchantId: jiopayMid,
      responseCode: '0000',
      amount: '1.00',
      merchantTxnNo: 'mtxn-probe',
      paymentID: 'pay-probe',
      paymentMode: 'UPI',
      paymentDateTime: '20260915120000',
      customerMobileNo: MOBILE,
      customerEmailID: EMAIL,
    };
    await service.persist(callback, { raw: 'body' });
    return { unexpected: true };
  }

  // Triggers a genuine P2010 whose meta.message embeds the raw mobile —
  // the nested-meta vector confirmed live during planning.
  @Get('trigger-nested-meta-error')
  async triggerNestedMetaError() {
    await prisma.$queryRawUnsafe(`SELECT '${MOBILE}'::integer`);
    return { unexpected: true };
  }

  // Control: a P2002 carries no PII (meta.target is field names only) — the
  // filter must not mangle an already-safe, unrelated error message.
  @Get('trigger-unrelated-p2002')
  async triggerUnrelatedP2002(@Query('merchantId') merchantId: string) {
    const txnId = uid('dup');
    await prisma.order.create({ data: { merchantId, status: 'SUCCESS', txnId, rawCallback: {} } });
    await prisma.order.create({ data: { merchantId, status: 'SUCCESS', txnId, rawCallback: {} } });
    return { unexpected: true };
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

describe('PrismaPiiScrubFilter (real Nest app, real Postgres)', () => {
  let app: import('@nestjs/common').INestApplication;
  let baseUrl: string;
  let merchantId: string;
  let jiopayMid: string;

  beforeAll(async () => {
    jiopayMid = uid('mid');
    const merchant = await prisma.merchant.create({
      data: { jiopayMid, name: `Q-2 itest ${jiopayMid}`, secretKeyEnc: Buffer.from('unused') },
    });
    merchantId = merchant.id;
    const template = await prisma.template.create({
      data: {
        merchantId,
        name: `Q-2 itest template ${merchantId}`,
        billType: 'RECEIPT',
        layoutSchema: { schemaVersion: 2, skeleton: 'MINIMALIST', blocks: [] },
        isHead: true,
      },
    });
    await prisma.merchant.update({ where: { id: merchantId }, data: { defaultReceiptTemplateId: template.id } });

    app = await NestFactory.create(ProbeModule, { logger: false });
    app.useGlobalFilters(new PrismaPiiScrubFilter(app.get(HttpAdapterHost).httpAdapter));
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address();
    const port = typeof address === 'object' && address ? address.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await prisma.order.deleteMany({ where: { merchantId } });
    await prisma.merchant.update({ where: { id: merchantId }, data: { defaultReceiptTemplateId: null } });
    await prisma.template.deleteMany({ where: { merchantId } });
    await prisma.merchant.delete({ where: { id: merchantId } });
    await app.close();
    await prisma.$disconnect();
  });

  // THE test that matters most (1 of 2): live-triggered error, substring
  // leak check on BOTH .message and .stack, exactly as Nest's default
  // logger call passes them.
  it('scrubs a REAL mobile and email from both the logged message and stack (live PrismaClientValidationError via the real service path)', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    errorSpy.mockClear();

    const res = await fetch(`${baseUrl}/test/trigger-validation-error?merchantId=${merchantId}&jiopayMid=${jiopayMid}`);
    await res.text();

    expect(errorSpy).toHaveBeenCalled();
    const [loggedMessage, loggedStack] = errorSpy.mock.calls[errorSpy.mock.calls.length - 1];

    // substring-level, not field-absence-level
    for (const leak of [MOBILE, EMAIL, 'realcustomer']) {
      expect(String(loggedMessage)).not.toContain(leak);
      expect(String(loggedStack)).not.toContain(leak);
    }
    // prove the log line is the REAL dump, not an empty/replaced string —
    // the surrounding structure survives, only the PII is gone.
    expect(String(loggedMessage)).toContain('Invalid `this.prisma.order.upsert()` invocation');
    expect(String(loggedMessage)).toContain('customerMobile_pii'); // key survives
    expect(String(loggedMessage)).toMatch(/customerMobile_pii:\s*"98\*+10"/); // maskMobile's actual output
    expect(String(loggedMessage)).toMatch(/customerEmail_pii:\s*"r\*+@example\.com"/); // maskEmail's actual output

    errorSpy.mockRestore();
  });

  // THE test that matters most (2 of 2): response byte-identical to what
  // BaseExceptionFilter's handleUnknownError() produces today (confirmed
  // by reading the @nestjs/core source directly during planning).
  it('the client response is byte-identical to Nest\'s default non-HttpException handling — 500, the hardcoded generic body, nothing Prisma-specific', async () => {
    const res = await fetch(`${baseUrl}/test/trigger-validation-error?merchantId=${merchantId}&jiopayMid=${jiopayMid}`);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toEqual({ statusCode: 500, message: 'Internal server error' });
    // and definitely not a leak via the response itself
    expect(JSON.stringify(body)).not.toContain(MOBILE);
    expect(JSON.stringify(body)).not.toContain(EMAIL);
  });

  it('scrubs the nested meta.message vector (real P2010, Postgres echoes the raw value one level inside meta)', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    errorSpy.mockClear();

    const res = await fetch(`${baseUrl}/test/trigger-nested-meta-error`);
    await res.text();
    expect(res.status).toBe(500);

    expect(errorSpy).toHaveBeenCalled();
    const [loggedMessage, loggedStack] = errorSpy.mock.calls[errorSpy.mock.calls.length - 1];
    expect(String(loggedMessage)).not.toContain(MOBILE);
    expect(String(loggedStack)).not.toContain(MOBILE);
    expect(String(loggedMessage)).toContain('out of range for type integer'); // surrounding text survives

    errorSpy.mockRestore();
  });

  it('control: an unrelated, PII-free P2002 still logs its real (unscrubbed-because-nothing-to-scrub) message — the filter does not mangle safe errors', async () => {
    const errorSpy = jest.spyOn(Logger.prototype, 'error');
    errorSpy.mockClear();

    const res = await fetch(`${baseUrl}/test/trigger-unrelated-p2002?merchantId=${merchantId}`);
    await res.text();
    expect(res.status).toBe(500);

    expect(errorSpy).toHaveBeenCalled();
    const [loggedMessage] = errorSpy.mock.calls[errorSpy.mock.calls.length - 1];
    expect(String(loggedMessage)).toContain('Unique constraint failed on the fields: (`txnId`)');

    errorSpy.mockRestore();
  });
});
