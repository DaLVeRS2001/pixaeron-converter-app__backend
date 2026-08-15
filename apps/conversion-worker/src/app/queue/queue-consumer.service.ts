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
import {
  isMember,
  outputObjectKey,
  queueForTier,
  queueUrl,
  RETENTION_CLASSES,
  type ConversionRequestMessage,
} from '@pixaeron/conversion-contract';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

import { ImageCompressorService } from '../pipeline/image-compressor.service';
import {
  InputIntegrityError,
  WorkerObjectStorageService,
} from '../storage/worker-object-storage.service';
import { WorkerEventsService } from '../events/worker-events.service';
import { WORKER_SQS_CLIENT } from './worker-sqs.client';

const PRIORITY_TIERS = [3, 2, 1, 0];
const RECEIVE_WAIT_SECONDS = 20;
const RETRY_DELAY_MS = 1_000;
const MAX_RETRY_DELAY_MS = 30_000;
const CLAIM_VISIBILITY_SECONDS = 120;
const VISIBILITY_REFRESH_INTERVAL_MS = 45_000;
const STARVATION_GRANT_PERIOD = 8;

type Waiter = { priority: number; grant: () => void };

@Injectable()
export class QueueConsumerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(QueueConsumerService.name);
  private readonly queueUrls: string[];
  private readonly progressFile: string;
  private readonly shutdown = new AbortController();
  private running = false;
  private loops: Promise<void>[] = [];
  private busy = false;
  private waiters: Waiter[] = [];
  private grants = 0;

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
    this.queueUrls = PRIORITY_TIERS.map((tier) =>
      queueUrl(region, accountId, queueForTier(tier), suffix),
    );
    this.progressFile = configService.getOrThrow<string>(
      'WORKER_PROGRESS_FILE',
    );
  }

  onApplicationBootstrap(): void {
    this.running = true;
    this.loops = this.queueUrls.map((url, priority) =>
      this.pollLoop(priority, url).finally(() => {
        if (!this.running) return;
        this.logger.error(`Consumer loop for ${url} died; stopping`);
        process.kill(process.pid, 'SIGTERM');
      }),
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.running = false;
    this.shutdown.abort();
    await Promise.all(this.loops);
    this.client.destroy();
  }

  private async pollLoop(priority: number, url: string): Promise<void> {
    let consecutiveFailures = 0;

    while (this.running) {
      try {
        const response = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: url,
            MaxNumberOfMessages: 1,
            WaitTimeSeconds: RECEIVE_WAIT_SECONDS,
            VisibilityTimeout: CLAIM_VISIBILITY_SECONDS,
            MessageSystemAttributeNames: ['ApproximateReceiveCount'],
          }),
          { abortSignal: this.shutdown.signal },
        );

        consecutiveFailures = 0;
        this.recordProgress();

        const message = response.Messages?.[0];
        if (!message?.ReceiptHandle) continue;

        const receiptHandle = message.ReceiptHandle;
        const visibilityRefresh = setInterval(() => {
          this.recordProgress();
          this.client
            .send(
              new ChangeMessageVisibilityCommand({
                QueueUrl: url,
                ReceiptHandle: receiptHandle,
                VisibilityTimeout: CLAIM_VISIBILITY_SECONDS,
              }),
            )
            .catch((error: Error) => {
              this.logger.error(`Visibility refresh failed: ${error.message}`);
            });
        }, VISIBILITY_REFRESH_INTERVAL_MS);

        try {
          await this.acquire(priority);
          try {
            await this.handle(url, message);
          } finally {
            this.release();
          }
        } finally {
          clearInterval(visibilityRefresh);
        }
      } catch (error) {
        if (!this.running || this.shutdown.signal.aborted) break;

        consecutiveFailures++;
        this.logger.error(
          `Queue poll failed for ${url} ${consecutiveFailures} times in a row: ${(error as Error).message}`,
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

  private recordProgress(): void {
    writeFile(this.progressFile, '').catch((error: Error) => {
      this.logger.error(`Progress file write failed: ${error.message}`);
    });
  }

  private acquire(priority: number): Promise<void> {
    if (!this.busy) {
      this.busy = true;
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.waiters.push({ priority, grant: resolve });
      this.waiters.sort((a, b) => a.priority - b.priority);
    });
  }

  private release(): void {
    const starvedTurn =
      this.grants % STARVATION_GRANT_PERIOD === STARVATION_GRANT_PERIOD - 1;
    const next = starvedTurn ? this.waiters.pop() : this.waiters.shift();
    if (next) {
      this.grants++;
      next.grant();
    } else {
      this.busy = false;
    }
  }

  async handle(url: string, message: Message): Promise<void> {
    const request = parseConversionRequest(message.Body ?? '');
    if (!request || !message.ReceiptHandle) {
      this.logger.error(
        `Malformed conversion request on ${url}; leaving for redrive`,
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
        await this.deleteMessage(url, message.ReceiptHandle);
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
      await this.deleteMessage(url, message.ReceiptHandle);
      return;
    }

    const objectKey = outputObjectKey(request.batchId, request.fileId, attempt);
    const checksum = createHash('sha256').update(result.bytes).digest('base64');
    await this.storage.putOutput(
      objectKey,
      result.bytes,
      result.contentType,
      checksum,
      request.outputRetention,
    );
    await this.events.publish({
      type: 'RESULT',
      ...base,
      outcome: 'COMPLETED',
      resultKind: result.kind,
      inputFormat: result.format,
      frameCount: result.frames,
      outputObjectKey: objectKey,
      outputBytes: result.bytes.length,
      outputChecksumSha256: checksum,
      outputFormat: result.format,
      width: result.width,
      height: result.height,
    });
    await this.deleteMessage(url, message.ReceiptHandle);
  }

  private async deleteMessage(
    url: string,
    receiptHandle: string,
  ): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: url,
        ReceiptHandle: receiptHandle,
      }),
    );
  }
}

export const parseConversionRequest = (
  body: string,
): ConversionRequestMessage | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const { fileId, batchId, inputObjectKey, inputEtag, outputRetention } =
    parsed as Record<string, unknown>;
  const isNonEmptyString = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0;
  if (
    !isNonEmptyString(fileId) ||
    !isNonEmptyString(batchId) ||
    !isNonEmptyString(inputObjectKey) ||
    !isNonEmptyString(inputEtag)
  ) {
    return null;
  }

  return {
    fileId,
    batchId,
    inputObjectKey,
    inputEtag,
    outputRetention: isMember(RETENTION_CLASSES, outputRetention)
      ? outputRetention
      : 'standard',
  };
};
