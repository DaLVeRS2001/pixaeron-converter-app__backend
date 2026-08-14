import {
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SQSClient,
  type Message,
} from '@aws-sdk/client-sqs';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EVENTS_QUEUE,
  isMember,
  queueUrl,
  RESULT_KINDS,
  type WorkerResultEvent,
  type WorkerStartedEvent,
} from '@pixaeron/conversion-contract';

import { WorkerEventProcessorService } from './worker-event-processor.service';

const RECEIVE_BATCH_SIZE = 10;
const RECEIVE_WAIT_SECONDS = 20;
const VISIBILITY_TIMEOUT_SECONDS = 60;
const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;

@Injectable()
export class WorkerEventsConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(WorkerEventsConsumer.name);
  private readonly client: SQSClient;
  private readonly eventsQueueUrl: string;
  private readonly shutdown = new AbortController();
  private running = false;
  private loop?: Promise<void>;

  constructor(
    private readonly processor: WorkerEventProcessorService,
    configService: ConfigService,
  ) {
    const region = configService.getOrThrow<string>('AWS_REGION');
    this.eventsQueueUrl = queueUrl(
      region,
      configService.getOrThrow<string>('AWS_ACCOUNT_ID'),
      EVENTS_QUEUE,
      configService.get<string>('SQS_QUEUE_SUFFIX') ?? '',
    );
    this.client = new SQSClient({
      region,
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
    });
  }

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.pollContinuously().finally(() => {
      if (!this.running) return;
      this.logger.error('Worker events consumer loop died; stopping');
      process.kill(process.pid, 'SIGTERM');
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.shutdown.abort();
    await this.loop;
    this.client.destroy();
  }

  private async pollContinuously(): Promise<void> {
    let consecutiveFailures = 0;

    while (this.running) {
      try {
        const response = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.eventsQueueUrl,
            MaxNumberOfMessages: RECEIVE_BATCH_SIZE,
            WaitTimeSeconds: RECEIVE_WAIT_SECONDS,
            VisibilityTimeout: VISIBILITY_TIMEOUT_SECONDS,
          }),
          { abortSignal: this.shutdown.signal },
        );
        consecutiveFailures = 0;

        const handled = await Promise.allSettled(
          (response.Messages ?? []).map((message) => this.handle(message)),
        );
        for (const outcome of handled) {
          if (outcome.status === 'rejected') {
            this.logger.error(
              `Worker event handling failed: ${outcome.reason?.message}`,
            );
          }
        }
      } catch (error) {
        if (!this.running || this.shutdown.signal.aborted) break;

        consecutiveFailures++;
        this.logger.error(
          `Worker events poll failed ${consecutiveFailures} times in a row: ${(error as Error).message}`,
        );
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(
              RETRY_DELAY_MS * 2 ** (consecutiveFailures - 1),
              MAX_RETRY_DELAY_MS,
            ),
          ),
        );
      }
    }
  }

  async handle(message: Message): Promise<void> {
    const event = parseWorkerEvent(message.Body ?? '');
    if (!event || !message.ReceiptHandle) {
      this.logger.error(
        `Malformed worker event; leaving for redrive: ${(message.Body ?? '').slice(0, 200)}`,
      );
      return;
    }

    await this.processor.apply(event);

    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.eventsQueueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
  }
}

const MAX_SIGNED_INT = 2_147_483_647;
const SHA256_BASE64 = /^[A-Za-z0-9+/]{43}=$/;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0;

const isPositiveInteger = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isInteger(value) &&
  value > 0 &&
  value <= MAX_SIGNED_INT;

export const parseWorkerEvent = (
  body: string,
): WorkerStartedEvent | WorkerResultEvent | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const event = parsed as Record<string, unknown>;
  const { fileId, batchId, attempt } = event;
  if (
    !isNonEmptyString(fileId) ||
    !isNonEmptyString(batchId) ||
    !isPositiveInteger(attempt)
  ) {
    return null;
  }

  const identity = { fileId, batchId, attempt };
  if (event['type'] === 'STARTED') {
    return { type: 'STARTED', ...identity };
  }
  if (event['type'] !== 'RESULT') return null;

  if (event['outcome'] === 'FAILED') {
    const failureCode = event['failureCode'];
    return isNonEmptyString(failureCode)
      ? { type: 'RESULT', ...identity, outcome: 'FAILED', failureCode }
      : null;
  }
  if (event['outcome'] !== 'COMPLETED') return null;

  const {
    resultKind,
    inputFormat,
    frameCount,
    outputObjectKey,
    outputBytes,
    outputChecksumSha256,
    outputFormat,
    width,
    height,
  } = event;
  if (
    !isMember(RESULT_KINDS, resultKind) ||
    !isNonEmptyString(inputFormat) ||
    !isNonEmptyString(outputFormat) ||
    !isNonEmptyString(outputObjectKey) ||
    !isNonEmptyString(outputChecksumSha256) ||
    !SHA256_BASE64.test(outputChecksumSha256) ||
    !isPositiveInteger(frameCount) ||
    !isPositiveInteger(outputBytes) ||
    !isPositiveInteger(width) ||
    !isPositiveInteger(height)
  ) {
    return null;
  }

  return {
    type: 'RESULT',
    ...identity,
    outcome: 'COMPLETED',
    resultKind,
    inputFormat,
    frameCount,
    outputObjectKey,
    outputBytes,
    outputChecksumSha256,
    outputFormat,
    width,
    height,
  };
};
