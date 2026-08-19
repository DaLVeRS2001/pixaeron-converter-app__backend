import { SQSClient } from '@aws-sdk/client-sqs';
import { ConfigService } from '@nestjs/config';
import type { Provider } from '@nestjs/common';

import { explicitAwsCredentials } from '../config/aws-credentials';

export const WORKER_SQS_CLIENT = Symbol('WORKER_SQS_CLIENT');

export const workerSqsClientProvider: Provider = {
  provide: WORKER_SQS_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService) =>
    new SQSClient({
      region: configService.getOrThrow<string>('AWS_REGION'),
      credentials: explicitAwsCredentials(configService),
      requestHandler: {
        connectionTimeout: 2_000,
        requestTimeout: 25_000,
        throwOnRequestTimeout: true,
      },
      useQueueUrlAsEndpoint: false,
    }),
};
