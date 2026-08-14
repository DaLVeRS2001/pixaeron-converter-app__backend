import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  QueueAttributeName,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { setTimeout as delay } from 'node:timers/promises';

import {
  ConflictingSesFeedbackError,
  SesFeedbackProcessor,
} from './ses-feedback.processor';

export const SES_FEEDBACK_SQS_CLIENT = Symbol('SES_FEEDBACK_SQS_CLIENT');

const RECEIVE_WAIT_SECONDS = 20;
const VISIBILITY_TIMEOUT_SECONDS = 60;
const RECEIVE_BATCH_SIZE = 10;
const RETRY_DELAY_MS = 1_000;

@Injectable()
export class SesFeedbackConsumer
  implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(SesFeedbackConsumer.name);
  private readonly queueUrl: string;
  private readonly expectedQueueArn: string;
  private readonly enabled: boolean;
  private running = false;
  private receiveAbortController?: AbortController;
  private loop?: Promise<void>;

  constructor(
    @Inject(SES_FEEDBACK_SQS_CLIENT)
    private readonly sqsClient: SQSClient,
    private readonly processor: SesFeedbackProcessor,
    configService: ConfigService,
  ) {
    this.queueUrl = configService.getOrThrow<string>('SES_FEEDBACK_QUEUE_URL');
    const region = configService.getOrThrow<string>('AWS_REGION');
    const accountId = configService.getOrThrow<string>(
      'SES_EXPECTED_ACCOUNT_ID',
    );
    const queueName = this.queueUrl.slice(this.queueUrl.lastIndexOf('/') + 1);
    this.expectedQueueArn = `arn:aws:sqs:${region}:${accountId}:${queueName}`;
    this.enabled =
      configService.getOrThrow<string>('SES_FEEDBACK_CONSUMER_ENABLED') ===
      'true';
  }

  async onModuleInit(): Promise<void> {
    if (this.enabled) await this.verifyQueueIdentity();
  }

  onApplicationBootstrap(): void {
    if (!this.enabled) return;

    this.running = true;
    this.loop = this.pollContinuously();
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.receiveAbortController?.abort();
    await this.loop;
    this.sqsClient.destroy();
  }

  private async verifyQueueIdentity(): Promise<void> {
    const response = await this.sqsClient.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.queueUrl,
        AttributeNames: [QueueAttributeName.QueueArn],
      }),
    );
    const queueArn = response.Attributes?.[QueueAttributeName.QueueArn];
    if (queueArn !== this.expectedQueueArn) {
      throw new Error('SES feedback queue ARN does not match configuration');
    }
  }

  async pollOnce(abortSignal?: AbortSignal): Promise<void> {
    const response = await this.sqsClient.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: RECEIVE_BATCH_SIZE,
        WaitTimeSeconds: RECEIVE_WAIT_SECONDS,
        VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
      }),
      { abortSignal },
    );

    await Promise.all(
      (response.Messages ?? []).map((message) => this.processMessage(message)),
    );
  }

  private async pollContinuously(): Promise<void> {
    while (this.running) {
      try {
        this.receiveAbortController = new AbortController();
        await this.pollOnce(this.receiveAbortController.signal);
      } catch (error) {
        if (!this.running || isAbortError(error)) break;

        this.logger.error('SES feedback poll category=retry.');
        await delay(RETRY_DELAY_MS);
      } finally {
        this.receiveAbortController = undefined;
      }
    }
  }

  private async processMessage(message: Message): Promise<void> {
    const body = message.Body;
    const receiptHandle = message.ReceiptHandle;

    if (!body || !receiptHandle) {
      this.logger.error('SES feedback category=validation; action=retry.');
      return;
    }

    try {
      const result = await this.processor.process(body);
      await this.sqsClient.send(
        new DeleteMessageCommand({
          QueueUrl: this.queueUrl,
          ReceiptHandle: receiptHandle,
        }),
      );

      const category = result === 'DUPLICATE' ? 'duplicate' : 'success';
      this.logger.log(`SES feedback category=${category}.`);
    } catch (error) {
      const category = isFeedbackValidationError(error)
        ? 'validation'
        : 'retry';
      this.logger.error(`SES feedback category=${category}; action=retry.`);
    }
  }
}

function isFeedbackValidationError(error: unknown): boolean {
  const isParserValidationError =
    error instanceof Error && error.message.startsWith('Invalid SES feedback:');

  return (
    isParserValidationError || error instanceof ConflictingSesFeedbackError
  );
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
