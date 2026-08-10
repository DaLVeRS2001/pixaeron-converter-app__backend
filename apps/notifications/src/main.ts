import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { type MicroserviceOptions, Transport } from '@nestjs/microservices';
import { join } from 'node:path';

import { runEmailRecoveryCommand } from './app/operator-command';

const globalPrefix = 'notifications';
const protoPackage = 'pixaeron.notifications.v1';
const protoPath = join(
  __dirname,
  'proto/pixaeron/notifications/v1/notifications.proto',
);

async function bootstrapServer(): Promise<void> {
  const { AppModule } = await import('./app/app.module');
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const httpPort = Number(config.getOrThrow<string>('PORT'));
  const grpcHost = config.getOrThrow<string>('NOTIFICATIONS_GRPC_HOST');
  const grpcPort = Number(config.getOrThrow<string>('NOTIFICATIONS_GRPC_PORT'));
  const grpcAddress = `${grpcHost}:${grpcPort}`;

  app.setGlobalPrefix(globalPrefix);
  app.enableShutdownHooks();
  app.connectMicroservice<MicroserviceOptions>({
    transport: Transport.GRPC,
    options: {
      package: protoPackage,
      protoPath,
      url: grpcAddress,
    },
  });

  try {
    await app.init();
    await app.startAllMicroservices();
    await app.listen(httpPort);
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }

  Logger.log(`Notifications HTTP health is listening on port ${httpPort}`);
  Logger.log(`Notifications gRPC is listening on ${grpcAddress}`);
}

async function run(): Promise<void> {
  if (process.argv[2] === 'email-recovery') {
    await runEmailRecoveryCommand();
    return;
  }

  await bootstrapServer();
}

run().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : 'Unknown error';
  Logger.error(`Notifications process failed during startup: ${reason}`);
  process.exit(1);
});
