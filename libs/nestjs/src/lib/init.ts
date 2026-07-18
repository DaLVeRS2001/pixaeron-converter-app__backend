import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser = require('cookie-parser');

export async function init(app: INestApplication, globalPrefix = 'api') {
  const configService = app.get(ConfigService);
  const trustProxy = configService.get<string>('TRUST_PROXY');

  if (trustProxy) {
    const normalizedTrustProxy = trustProxy.trim();
    const trustProxyValue = /^\d+$/.test(normalizedTrustProxy)
      ? Number(normalizedTrustProxy)
      : normalizedTrustProxy === 'true'
        ? true
        : normalizedTrustProxy === 'false'
          ? false
          : normalizedTrustProxy;

    app.getHttpAdapter().getInstance().set('trust proxy', trustProxyValue);
  }

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
