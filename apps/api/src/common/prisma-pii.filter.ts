import { ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { scrubPiiDeep, scrubPiiFromText } from './pii-scrub.util';

// Q-2 (D-94): Prisma's own error classes are not HttpExceptions, so today
// they fall through to Nest's default handling — which logs BOTH
// exception.message and exception.stack (confirmed by reading
// BaseExceptionFilter's source: `logger.error(exception.message,
// exception.stack)`), and a PrismaClientValidationError's message is a
// full pretty-printed dump of the call's arguments, PII included.
//
// @Catch() is scoped to exactly these four classes, so Nest's exception
// chain never routes any other error type through here — every other
// exception (HttpExceptions the app already throws deliberately, or any
// other error class) is handled exactly as it is today, untouched.
//
// Extending BaseExceptionFilter and delegating to super.catch() after
// scrubbing means the client-visible response is byte-identical to
// today's: none of these four classes are HttpExceptions, so
// super.catch() always takes the handleUnknownError() branch and replies
// with the same hardcoded generic 500 body Nest already sends today —
// only the two arguments passed to the logger change.
@Catch(
  Prisma.PrismaClientKnownRequestError,
  Prisma.PrismaClientValidationError,
  Prisma.PrismaClientUnknownRequestError,
  Prisma.PrismaClientRustPanicError,
)
export class PrismaPiiScrubFilter extends BaseExceptionFilter {
  catch(exception: Error & { meta?: unknown }, host: ArgumentsHost): void {
    if (typeof exception.message === 'string') {
      exception.message = scrubPiiFromText(exception.message);
    }
    if (typeof exception.stack === 'string') {
      exception.stack = scrubPiiFromText(exception.stack);
    }
    if (exception.meta !== undefined && exception.meta !== null) {
      exception.meta = scrubPiiDeep(exception.meta);
    }
    super.catch(exception, host);
  }
}
