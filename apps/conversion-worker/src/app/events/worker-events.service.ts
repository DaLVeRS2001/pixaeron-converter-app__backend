import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EVENTS_QUEUE,
  queueUrl,
  type WorkerResultEvent,
  type WorkerStartedEvent,
} from '@pixaeron/conversion-contract';

import { WORKER_SQS_CLIENT } from '../queue/worker-sqs.client';

@Injectable()
export class WorkerEventsService {
  private readonly eventsQueueUrl: string;

  constructor(
    @Inject(WORKER_SQS_CLIENT) private readonly client: SQSClient,
    configService: ConfigService,
  ) {
    this.eventsQueueUrl = queueUrl(
      configService.getOrThrow<string>('AWS_REGION'),
      configService.getOrThrow<string>('AWS_ACCOUNT_ID'),
      EVENTS_QUEUE,
      configService.get<string>('SQS_QUEUE_SUFFIX') ?? '',
    );
  }

  async publish(event: WorkerStartedEvent | WorkerResultEvent): Promise<void> {
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.eventsQueueUrl,
        MessageBody: JSON.stringify(event),
      }),
    );
  }
}
