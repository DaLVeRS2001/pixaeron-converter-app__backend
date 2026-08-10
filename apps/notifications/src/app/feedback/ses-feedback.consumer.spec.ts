import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  QueueAttributeName,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';

import { FeedbackModule } from './feedback.module';
import {
  SES_FEEDBACK_SQS_CLIENT,
  SesFeedbackConsumer,
} from './ses-feedback.consumer';
import {
  ConflictingSesFeedbackError,
  type SesFeedbackProcessor,
} from './ses-feedback.processor';

describe('SesFeedbackConsumer', () => {
  afterEach(() => jest.restoreAllMocks());

  it('long-polls a bounded batch and deletes only after processing commits', async () => {
    const operations: string[] = [];
    const send = jest.fn().mockImplementation((command: unknown) => {
      if (command instanceof ReceiveMessageCommand) {
        return Promise.resolve({
          Messages: [
            {
              MessageId: 'sqs-message-id',
              Body: 'trusted-envelope',
              ReceiptHandle: 'current-receipt-handle',
            },
          ],
        });
      }

      expect(command).toBeInstanceOf(DeleteMessageCommand);
      operations.push('delete');
      return Promise.resolve({});
    });
    const process = jest.fn().mockImplementation(async () => {
      operations.push('commit');
      return 'PROCESSED';
    });
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const consumer = createConsumer(send, process);

    await consumer.pollOnce();

    const receive = send.mock.calls[0][0] as ReceiveMessageCommand;
    expect(receive.input).toEqual({
      QueueUrl: 'https://sqs.eu-central-1.amazonaws.com/123456789012/feedback',
      MaxNumberOfMessages: 10,
      WaitTimeSeconds: 20,
      VisibilityTimeout: 60,
    });
    expect(process).toHaveBeenCalledWith('trusted-envelope');
    expect(operations).toEqual(['commit', 'delete']);

    const deletion = send.mock.calls[1][0] as DeleteMessageCommand;
    expect(deletion.input).toEqual({
      QueueUrl: 'https://sqs.eu-central-1.amazonaws.com/123456789012/feedback',
      ReceiptHandle: 'current-receipt-handle',
    });
    expect(log).toHaveBeenCalledWith('SES feedback category=success.');
  });

  it('logs an idempotent duplicate without sensitive message data', async () => {
    const send = jest.fn().mockImplementation((command: unknown) => {
      if (command instanceof ReceiveMessageCommand) {
        return Promise.resolve({
          Messages: [
            {
              MessageId: 'sqs-message-id',
              Body: 'trusted-envelope',
              ReceiptHandle: 'current-receipt-handle',
            },
          ],
        });
      }

      return Promise.resolve({});
    });
    const process = jest.fn().mockResolvedValue('DUPLICATE');
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    const consumer = createConsumer(send, process);

    await consumer.pollOnce();

    expect(send.mock.calls[1][0]).toBeInstanceOf(DeleteMessageCommand);
    expect(log).toHaveBeenCalledWith('SES feedback category=duplicate.');
    expect(JSON.stringify(log.mock.calls)).not.toContain('trusted-envelope');
    expect(JSON.stringify(log.mock.calls)).not.toContain('sqs-message-id');
  });

  it('leaves poison messages in SQS for retry and does not log the payload', async () => {
    const poisonBody = 'recipient@example.com raw provider payload';
    const send = jest.fn().mockResolvedValue({
      Messages: [
        {
          MessageId: 'poison-message-id',
          Body: poisonBody,
          ReceiptHandle: 'receipt-handle',
        },
      ],
    });
    const providerError = 'provider failed for recipient@example.com';
    const process = jest.fn().mockRejectedValue(new Error(providerError));
    const errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const consumer = createConsumer(send, process);

    await consumer.pollOnce();

    expect(send).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      'SES feedback category=retry; action=retry.',
    );
    const serializedLogs = JSON.stringify(errorLog.mock.calls);
    expect(serializedLogs).not.toContain(poisonBody);
    expect(serializedLogs).not.toContain(providerError);
    expect(serializedLogs).not.toContain('poison-message-id');
  });

  it('logs validation failures without exposing the provider error', async () => {
    const providerError = new ConflictingSesFeedbackError();
    const send = jest.fn().mockResolvedValue({
      Messages: [
        {
          MessageId: 'invalid-message-id',
          Body: 'recipient@example.com raw provider payload',
          ReceiptHandle: 'receipt-handle',
        },
      ],
    });
    const process = jest.fn().mockRejectedValue(providerError);
    const errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const consumer = createConsumer(send, process);

    await consumer.pollOnce();

    expect(send).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      'SES feedback category=validation; action=retry.',
    );
    const serializedLogs = JSON.stringify(errorLog.mock.calls);
    expect(serializedLogs).not.toContain(providerError.message);
    expect(serializedLogs).not.toContain('recipient@example.com');
    expect(serializedLogs).not.toContain('invalid-message-id');
  });

  it('verifies the exact queue ARN before polling', async () => {
    const send = jest
      .fn()
      .mockImplementation(
        (command: unknown, options?: { abortSignal?: AbortSignal }) => {
          if (command instanceof GetQueueAttributesCommand) {
            return Promise.resolve({
              Attributes: {
                [QueueAttributeName.QueueArn]:
                  'arn:aws:sqs:eu-central-1:123456789012:feedback',
              },
            });
          }

          return new Promise((_resolve, reject) => {
            options?.abortSignal?.addEventListener(
              'abort',
              () => {
                const error = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              },
              { once: true },
            );
          });
        },
      );
    const consumer = createConsumer(send, jest.fn(), true);

    await consumer.onModuleInit();

    const preflight = send.mock.calls[0][0] as GetQueueAttributesCommand;
    expect(preflight.input).toEqual({
      QueueUrl: 'https://sqs.eu-central-1.amazonaws.com/123456789012/feedback',
      AttributeNames: [QueueAttributeName.QueueArn],
    });
    expect(send).toHaveBeenCalledTimes(1);

    consumer.onApplicationBootstrap();
    expect(send.mock.calls[1][0]).toBeInstanceOf(ReceiveMessageCommand);

    await consumer.onModuleDestroy();
  });

  it('fails startup when SQS reports a different queue ARN', async () => {
    const send = jest.fn().mockResolvedValue({
      Attributes: {
        [QueueAttributeName.QueueArn]:
          'arn:aws:sqs:eu-central-1:123456789012:other-queue',
      },
    });
    const consumer = createConsumer(send, jest.fn(), true);

    await expect(consumer.onModuleInit()).rejects.toThrow(
      'SES feedback queue ARN does not match configuration',
    );
    expect(send).toHaveBeenCalledTimes(1);

    await consumer.onModuleDestroy();
  });

  it('fails startup when the SQS preflight request fails', async () => {
    const send = jest.fn().mockRejectedValue(new Error('access denied'));
    const consumer = createConsumer(send, jest.fn(), true);

    await expect(consumer.onModuleInit()).rejects.toThrow('access denied');
    expect(send).toHaveBeenCalledTimes(1);

    await consumer.onModuleDestroy();
  });

  it('uses the configured AWS endpoint instead of trusting QueueUrl as one', () => {
    type SqsClientProvider = {
      provide: symbol;
      useFactory: (configService: ConfigService) => SQSClient;
    };
    const providers = Reflect.getMetadata(
      'providers',
      FeedbackModule,
    ) as SqsClientProvider[];
    const provider = providers.find(
      ({ provide }) => provide === SES_FEEDBACK_SQS_CLIENT,
    );

    expect(provider).toBeDefined();
    const client = provider?.useFactory(
      new ConfigService({ AWS_REGION: 'eu-central-1' }),
    );
    expect(client?.config.useQueueUrlAsEndpoint).toBe(false);
    client?.destroy();
  });

  it('does not poll when the feedback consumer is disabled', async () => {
    const send = jest.fn();
    const consumer = createConsumer(send, jest.fn());

    await consumer.onModuleInit();
    await consumer.onModuleDestroy();

    expect(send).not.toHaveBeenCalled();
  });

  it('does not delete an incomplete SQS message', async () => {
    const send = jest.fn().mockResolvedValue({
      Messages: [{ MessageId: 'incomplete-message-id', Body: 'body' }],
    });
    const process = jest.fn();
    const errorLog = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const consumer = createConsumer(send, process);

    await consumer.pollOnce();

    expect(process).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      'SES feedback category=validation; action=retry.',
    );
  });
});

function createConsumer(
  send: jest.Mock,
  process: jest.Mock,
  enabled = false,
): SesFeedbackConsumer {
  const sqsClient = { send, destroy: jest.fn() } as unknown as SQSClient;
  const processor = { process } as unknown as SesFeedbackProcessor;
  const configService = {
    getOrThrow: jest.fn((name: string) => {
      if (name === 'SES_FEEDBACK_QUEUE_URL') {
        return 'https://sqs.eu-central-1.amazonaws.com/123456789012/feedback';
      }
      if (name === 'SES_FEEDBACK_CONSUMER_ENABLED') {
        return String(enabled);
      }
      if (name === 'AWS_REGION') return 'eu-central-1';
      if (name === 'SES_EXPECTED_ACCOUNT_ID') return '123456789012';
      throw new Error(`Unexpected config key: ${name}`);
    }),
  } as unknown as ConfigService;

  return new SesFeedbackConsumer(sqsClient, processor, configService);
}
