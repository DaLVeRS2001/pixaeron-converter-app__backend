require('module-alias/register');
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app/app.module';
import { init } from '@pixaeron/nestjs';

const globalPrefix = 'auth';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  await init(app, globalPrefix);
}

bootstrap();
