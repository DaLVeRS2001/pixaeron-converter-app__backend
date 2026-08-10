import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SQSClient } from '@aws-sdk/client-sqs';

import { DeliveryModule } from '../delivery/delivery.module';
import {
  SES_FEEDBACK_SQS_CLIENT,
  SesFeedbackConsumer,
} from './ses-feedback.consumer';
import { SesFeedbackProcessor } from './ses-feedback.processor';

@Module({
  imports: [DeliveryModule],
  providers: [
    {
      provide: SES_FEEDBACK_SQS_CLIENT,
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        new SQSClient({
          region: configService.getOrThrow<string>('AWS_REGION'),
          useQueueUrlAsEndpoint: false,
        }),
    },
    SesFeedbackProcessor,
    SesFeedbackConsumer,
  ],
})
export class FeedbackModule {}
