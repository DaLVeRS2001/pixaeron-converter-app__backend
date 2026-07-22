import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser = require('cookie-parser');

export function configureHttp(app: INestApplication) {
  const configService = app.get(ConfigService);
  const corsOrigins = configService
    .getOrThrow<string>('CORS_ORIGINS')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  // Caddy overwrites X-Forwarded-For before Docker forwards the request.
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  app.enableCors({
    origin: corsOrigins,
    credentials: true,
  });
}

export async function init(app: INestApplication, globalPrefix = 'api') {
  const configService = app.get(ConfigService);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.setGlobalPrefix(globalPrefix);
  app.use(cookieParser());
  const port = configService.getOrThrow('PORT');
  await app.listen(port);
  Logger.log(
    `Application is running on: http://localhost:${port}/${globalPrefix}`,
  );
}
