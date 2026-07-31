import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Only the demo control panel (app/demo/page.tsx) calls this API directly
  // from the browser — every other route is server-to-server (Next.js RSC,
  // JioPay callbacks). Scoped to the web dev origin, not a wildcard: CORS
  // controls which origins a browser will let read the response, it doesn't
  // replace each route's own auth (ApiKeyGuard/SecureHashGuard/DemoOnlyGuard).
  app.enableCors({ origin: 'http://localhost:3000' });
  app.useGlobalPipes(new ValidationPipe({ whitelist: false, forbidNonWhitelisted: false }));
  await app.listen(4000);
}
bootstrap();
