import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import sharp from 'sharp';

import { AppModule } from './app/app.module';

async function bootstrap(): Promise<void> {
  sharp.cache(false);
  sharp.concurrency(1);

  const app = await NestFactory.createApplicationContext(AppModule);
  app.enableShutdownHooks();
  Logger.log('Conversion worker is consuming the request queues');
}

bootstrap().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : 'Unknown error';
  Logger.error(`Conversion worker process failed during startup: ${reason}`);
  process.exit(1);
});
