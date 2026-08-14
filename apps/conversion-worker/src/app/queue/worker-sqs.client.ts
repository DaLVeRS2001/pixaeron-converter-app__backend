import { SQSClient } from '@aws-sdk/client-sqs';
import { ConfigService } from '@nestjs/config';
import type { Provider } from '@nestjs/common';

export const WORKER_SQS_CLIENT = Symbol('WORKER_SQS_CLIENT');

export const workerSqsClientProvider: Provider = {
  provide: WORKER_SQS_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) =>
    new SQSClient({
      region: configService.getOrThrow<string>('AWS_REGION'),
      credentials: {
        accessKeyId: configService.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: configService.getOrThrow<string>(
          'AWS_SECRET_ACCESS_KEY',
        ),
      },
      requestHandler: {
        connectionTimeout: 2_000,
        requestTimeout: 25_000,
        throwOnRequestTimeout: true,
      },
      useQueueUrlAsEndpoint: false,
    }),
};
