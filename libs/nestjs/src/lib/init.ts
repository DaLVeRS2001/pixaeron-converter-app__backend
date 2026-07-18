import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import cookieParser = require('cookie-parser');

export async function init(app: INestApplication, globalPrefix = 'api') {
  const configService = app.get(ConfigService);
  const trustProxy = configService.get<string>('TRUST_PROXY') ?? '0';

  if (trustProxy !== '0' && trustProxy !== '1') {
    throw new Error('TRUST_PROXY must be either 0 or 1');
  }

  app.getHttpAdapter().getInstance().set('trust proxy', Number(trustProxy));

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
