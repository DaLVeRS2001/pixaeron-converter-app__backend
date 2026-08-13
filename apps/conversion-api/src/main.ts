import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { configureHttp, init } from '@pixaeron/nestjs';

const globalPrefix = 'conversion';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  configureHttp(app);

  await init(app, globalPrefix);
}

bootstrap().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : 'Unknown error';
  Logger.error(`Conversion API process failed during startup: ${reason}`);
  process.exit(1);
});
