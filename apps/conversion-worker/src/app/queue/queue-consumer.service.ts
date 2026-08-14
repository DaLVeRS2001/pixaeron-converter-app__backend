import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import type { ConversionRequestMessage } from '../messages';
import { ImageCompressorService } from '../pipeline/image-compressor.service';
import {
  InputIntegrityError,
  WorkerObjectStorageService,
} from '../storage/worker-object-storage.service';
import { WorkerEventsService } from '../events/worker-events.service';
import { WORKER_SQS_CLIENT } from './worker-sqs.client';

const TIER_QUEUES = [
  'pixaeron-conversion-pro',
  'pixaeron-conversion-light',
  'pixaeron-conversion-free',
  'pixaeron-conversion-anon',
];
const RECEIVE_WAIT_SECONDS = 20;
const RETRY_DELAY_MS = 1_000;
const CLAIM_VISIBILITY_SECONDS = 120;
const HEARTBEAT_INTERVAL_MS = 45_000;

type Waiter = { tier: number; grant: () => void };

@Injectable()
export class QueueConsumerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(QueueConsumerService.name);
  private readonly queueUrls: string[];
  private running = false;
  private loops: Promise<void>[] = [];
  private abortControllers = new Map<number, AbortController>();
  private busy = false;
  private waiters: Waiter[] = [];

  constructor(
    @Inject(WORKER_SQS_CLIENT) private readonly client: SQSClient,
    private readonly storage: WorkerObjectStorageService,
    private readonly compressor: ImageCompressorService,
    private readonly events: WorkerEventsService,
    configService: ConfigService,
  ) {
    const region = configService.getOrThrow<string>('AWS_REGION');
    const accountId = configService.getOrThrow<string>('AWS_ACCOUNT_ID');
    const suffix = configService.get<string>('SQS_QUEUE_SUFFIX') ?? '';
    this.queueUrls = TIER_QUEUES.map(
      (queue) =>
        `https://sqs.${region}.amazonaws.com/${accountId}/${queue}${suffix}`,
    );
  }

  onApplicationBootstrap(): void {
    this.running = true;
    this.loops = this.queueUrls.map((queueUrl, tier) =>
      this.pollLoop(tier, queueUrl).finally(() => {
        if (!this.running) return;
        this.logger.error(`Consumer loop for ${queueUrl} died; stopping`);
        process.kill(process.pid, 'SIGTERM');
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    for (const controller of this.abortControllers.values()) {
      controller.abort();
    }
    await Promise.all(this.loops);
    this.client.destroy();
  }

  private async pollLoop(tier: number, queueUrl: string): Promise<void> {
    while (this.running) {
      try {
        const controller = new AbortController();
        this.abortControllers.set(tier, controller);
        const response = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: RECEIVE_WAIT_SECONDS,
            VisibilityTimeout: CLAIM_VISIBILITY_SECONDS,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
          { abortSignal: controller.signal },
        );

        const message = response.Messages?.[0];
        if (!message?.ReceiptHandle) continue;

        const receiptHandle = message.ReceiptHandle;
        const heartbeat = setInterval(() => {
          this.client
            .send(
              new ChangeMessageVisibilityCommand({
                QueueUrl: queueUrl,
                ReceiptHandle: receiptHandle,
                VisibilityTimeout: CLAIM_VISIBILITY_SECONDS,
              }),
            )
            .catch((error: Error) => {
              this.logger.error(`Heartbeat failed: ${error.message}`);
            });
        }, HEARTBEAT_INTERVAL_MS);

        try {
          await this.acquire(tier);
          try {
            await this.handle(queueUrl, message);
          } finally {
            this.release();
          }
        } finally {
          clearInterval(heartbeat);
        }
      } catch (error) {
        if (!this.running || (error as Error).name === 'AbortError') break;

        this.logger.error(
          `Queue poll failed for ${queueUrl}: ${(error as Error).message}`,
        );
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } finally {
        this.abortControllers.delete(tier);
      }
    }
  }

  private acquire(tier: number): Promise<void> {
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.waiters.push({ tier, grant: resolve });
      this.waiters.sort((a, b) => a.tier - b.tier);
    });
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next.grant();
    else this.busy = false;
  }

  private async handle(queueUrl: string, message: Message): Promise<void> {
    const receiptHandle = message.ReceiptHandle as string;

    let parsed: unknown;
    try {
      parsed = JSON.parse(message.Body ?? '');
    } catch {
      parsed = null;
    }
    const candidate = parsed as Partial<ConversionRequestMessage> | null;
    const request =
      candidate &&
      typeof candidate === 'object' &&
      [
        candidate.fileId,
        candidate.batchId,
        candidate.inputObjectKey,
        candidate.inputEtag,
      ].every((field) => typeof field === 'string' && field.length > 0)
        ? (candidate as ConversionRequestMessage)
        : null;
    if (!request) {
      this.logger.error(
        `Malformed conversion request on ${queueUrl}; leaving for redrive`,
      );
      return;
    }

    const attempt = Number(
      message.Attributes?.['ApproximateReceiveCount'] ?? '1',
    );
    const base = {
      fileId: request.fileId,
      batchId: request.batchId,
      attempt,
    };
    await this.events.publish({ type: 'STARTED', ...base });

    let input: Buffer;
    try {
      input = await this.storage.getInput(
        request.inputObjectKey,
        request.inputEtag,
      );
    } catch (error) {
      if (error instanceof InputIntegrityError) {
        await this.events.publish({
          type: 'RESULT',
          ...base,
          outcome: 'FAILED',
          failureCode: error.failureCode,
        });
        await this.deleteMessage(queueUrl, receiptHandle);
        return;
      }
      throw error;
    }

    const result = await this.compressor.compress(input);
    if (!result.ok) {
      await this.events.publish({
        type: 'RESULT',
        ...base,
        outcome: 'FAILED',
        failureCode: result.failureCode,
      });
      await this.deleteMessage(queueUrl, receiptHandle);
      return;
    }

    const outputObjectKey = `outputs/${request.batchId}/${request.fileId}`;
    await this.storage.putOutput(
      outputObjectKey,
      result.bytes,
      result.contentType,
    );
    await this.events.publish({
      type: 'RESULT',
      ...base,
      outcome: 'COMPLETED',
      resultKind: result.kind,
      outputObjectKey,
      outputBytes: result.bytes.length,
      outputChecksum: createHash('sha256').update(result.bytes).digest('hex'),
      outputFormat: result.format,
      width: result.width,
      height: result.height,
    });
    await this.deleteMessage(queueUrl, receiptHandle);
  }

  private async deleteMessage(
    queueUrl: string,
    receiptHandle: string,
  ): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }
}
