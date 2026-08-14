import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { type MicroserviceOptions, Transport } from '@nestjs/microservices';
import { ENTITLEMENTS_GRPC_LOADER } from '@pixaeron/entitlements-contract';
import { join } from 'node:path';
import { AppModule } from './app/app.module';
import { configureHttp, init } from '@pixaeron/nestjs';
import { HttpRateLimitMiddleware } from '@pixaeron/rate-limit';

const globalPrefix = 'auth';
const entitlementsProtoPath = join(
  __dirname,
  'proto/pixaeron/entitlements/v1/entitlements.proto',
);

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  configureHttp(app);

  const httpRateLimiter = app.get(HttpRateLimitMiddleware);
  app.use('/auth', httpRateLimiter.use.bind(httpRateLimiter));

  const config = app.get(ConfigService);
  const entitlementsHost = config.get<string>('ENTITLEMENTS_GRPC_HOST');
  const entitlementsPort = config.get<string>('ENTITLEMENTS_GRPC_PORT');

  if (entitlementsHost && entitlementsPort) {
    const entitlementsAddress = `${entitlementsHost}:${entitlementsPort}`;
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.GRPC,
      options: {
        package: 'pixaeron.entitlements.v1',
        protoPath: entitlementsProtoPath,
        url: entitlementsAddress,
        loader: { ...ENTITLEMENTS_GRPC_LOADER },
      },
    });
    await app.startAllMicroservices();
    Logger.log(`Auth entitlements gRPC is listening on ${entitlementsAddress}`);
  }

  await init(app, globalPrefix);
}

bootstrap().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : 'Unknown error';
  Logger.error(`Auth process failed during startup: ${reason}`);
  process.exit(1);
});
