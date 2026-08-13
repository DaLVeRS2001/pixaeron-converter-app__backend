import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { configureHttp, init } from '@pixaeron/nestjs';
import { HttpRateLimitMiddleware } from '@pixaeron/rate-limit';

const globalPrefix = 'conversion';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // CORS must run before middleware that can terminate a request early.
  configureHttp(app);

  const httpRateLimiter = app.get(HttpRateLimitMiddleware);

  // Mount before Apollo so malformed GraphQL requests are rate-limited too.
  app.use('/conversion', httpRateLimiter.use.bind(httpRateLimiter));

  await init(app, globalPrefix);
}

bootstrap().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : 'Unknown error';
  Logger.error(`Conversion API process failed during startup: ${reason}`);
  process.exit(1);
});
