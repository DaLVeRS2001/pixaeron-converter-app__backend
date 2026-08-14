import { SendMessageCommand, SQSClient } from '@aws-sdk/client-sqs';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { queueUrl } from '@pixaeron/conversion-contract';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const CLAIM_BATCH_SIZE = 10;
const CLAIM_TRANSACTION_TIMEOUT_MS = 20_000;
const SEND_DEADLINE_MS = 12_000;

type ClaimedEvent = {
  id: string;
  queue: string;
  payload: unknown;
};

@Injectable()
export class OutboxPublisherService {
  private readonly logger = new Logger(OutboxPublisherService.name);
  private readonly client: SQSClient;
  private readonly region: string;
  private readonly accountId: string;
  private readonly queueSuffix: string;
  private inFlight?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    const region = configService.getOrThrow<string>('AWS_REGION');
    this.region = region;
    this.accountId = configService.getOrThrow<string>('AWS_ACCOUNT_ID');
    this.queueSuffix = configService.get<string>('SQS_QUEUE_SUFFIX') ?? '';
    this.client = new SQSClient({
      region,
      credentials: {
        accessKeyId: configService.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: configService.getOrThrow<string>(
          'AWS_SECRET_ACCESS_KEY',
        ),
      },
      maxAttempts: 1,
      requestHandler: {
        connectionTimeout: 2_000,
        requestTimeout: 5_000,
        throwOnRequestTimeout: true,
      },
      useQueueUrlAsEndpoint: false,
    });
  }

  @Cron(CronExpression.EVERY_5_SECONDS, { waitForCompletion: true })
  drain(): Promise<void> {
    this.inFlight ??= (async () => {
      try {
        let claimed: number;
        do {
          claimed = await this.prisma.$transaction(
            async (transaction) => {
              const events = await transaction.$queryRaw<ClaimedEvent[]>`
                SELECT "id", "queue", "payload"
                FROM "outbox_events"
                WHERE "status" = 'PENDING' AND "next_attempt_at" <= now()
                ORDER BY "next_attempt_at"
                LIMIT ${CLAIM_BATCH_SIZE}
                FOR UPDATE SKIP LOCKED
              `;

              const deliveredIds: string[] = [];
              const failedIds: string[] = [];
              const deadline = Date.now() + SEND_DEADLINE_MS;
              for (const event of events) {
                if (Date.now() > deadline) break;
                try {
                  await this.client.send(
                    new SendMessageCommand({
                      QueueUrl: queueUrl(
                        this.region,
                        this.accountId,
                        event.queue,
                        this.queueSuffix,
                      ),
                      MessageBody: JSON.stringify(event.payload),
                    }),
                  );
                  deliveredIds.push(event.id);
                } catch (error) {
                  this.logger.error(
                    `Outbox publish to ${event.queue} failed: ${(error as Error).message}`,
                  );
                  failedIds.push(event.id);
                }
              }

              if (deliveredIds.length > 0) {
                await transaction.outboxEvent.deleteMany({
                  where: { id: { in: deliveredIds } },
                });
              }
              if (failedIds.length > 0) {
                await transaction.$executeRaw`
                  UPDATE "outbox_events"
                  SET "attempts" = "attempts" + 1,
                      "next_attempt_at" = now() + LEAST(
                        power(2, LEAST("attempts", 10)) * interval '5 seconds',
                        interval '15 minutes'
                      )
                  WHERE "id" IN (${Prisma.join(failedIds)})
                `;
              }

              return events.length;
            },
            { timeout: CLAIM_TRANSACTION_TIMEOUT_MS },
          );
        } while (claimed === CLAIM_BATCH_SIZE);
      } catch (error) {
        this.logger.error(`Outbox drain failed: ${(error as Error).message}`);
      }
    })().finally(() => {
      this.inFlight = undefined;
    });

    return this.inFlight;
  }
}
