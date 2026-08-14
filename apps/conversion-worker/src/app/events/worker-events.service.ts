import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { WORKER_SQS_CLIENT } from '../queue/worker-sqs.client';
import type { WorkerResultEvent, WorkerStartedEvent } from '../messages';

@Injectable()
export class WorkerEventsService {
  private readonly eventsQueueUrl: string;

  constructor(
    @Inject(WORKER_SQS_CLIENT) private readonly client: SQSClient,
    configService: ConfigService,
  ) {
    const region = configService.getOrThrow<string>('AWS_REGION');
    const accountId = configService.getOrThrow<string>('AWS_ACCOUNT_ID');
    const suffix = configService.get<string>('SQS_QUEUE_SUFFIX') ?? '';
    this.eventsQueueUrl = `https://sqs.${region}.amazonaws.com/${accountId}/pixaeron-conversion-events${suffix}`;
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
