import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import { QueueConsumerService } from './queue-consumer.service';
import { InputIntegrityError } from '../storage/worker-object-storage.service';
import type { Message } from '@aws-sdk/client-sqs';

type Handle = (queueUrl: string, message: Message) => Promise<void>;

const QUEUE_URL =
  'https://sqs.eu-central-1.amazonaws.com/123456789012/pixaeron-conversion-anon-dev';

describe('QueueConsumerService', () => {
  let client: { send: jest.Mock; destroy: jest.Mock };
  let storage: { getInput: jest.Mock; putOutput: jest.Mock };
  let compressor: { compress: jest.Mock };
  let events: { publish: jest.Mock };
  let service: QueueConsumerService;

  beforeEach(() => {
    client = { send: jest.fn().mockResolvedValue({}), destroy: jest.fn() };
    storage = {
      getInput: jest.fn().mockResolvedValue(Buffer.from('input-bytes')),
      putOutput: jest.fn().mockResolvedValue(undefined),
    };
    compressor = {
      compress: jest.fn().mockResolvedValue({
        ok: true,
        kind: 'SAVED',
        bytes: Buffer.from('output-bytes'),
        format: 'jpeg',
        contentType: 'image/jpeg',
        frames: 1,
        width: 10,
        height: 20,
      }),
    };
    events = { publish: jest.fn().mockResolvedValue(undefined) };
    service = new QueueConsumerService(
      client as never,
      storage as never,
      compressor as never,
      events as never,
      new ConfigService({
        AWS_REGION: 'eu-central-1',
        AWS_ACCOUNT_ID: '123456789012',
        SQS_QUEUE_SUFFIX: '-dev',
      }),
    );
  });

  const message = (overrides: Partial<Message> = {}): Message => ({
    MessageId: 'message-1',
    ReceiptHandle: 'receipt-1',
    Body: JSON.stringify({
      fileId: 'file-1',
      batchId: 'batch-1',
      inputObjectKey: 'inputs/batch-1/file-1',
      inputEtag: 'etag-1',
    }),
    Attributes: { ApproximateReceiveCount: '2' },
    ...overrides,
  });

  const handle = () =>
    (service as unknown as { handle: Handle }).handle.bind(service);

  const sentCommands = () =>
    client.send.mock.calls.map(([command]) => command.constructor.name);

  it('processes a request through started, upload, result, and delete', async () => {
    await handle()(QUEUE_URL, message());

    expect(events.publish).toHaveBeenNthCalledWith(1, {
      type: 'STARTED',
      fileId: 'file-1',
      batchId: 'batch-1',
      attempt: 2,
    });
    expect(storage.getInput).toHaveBeenCalledWith(
      'inputs/batch-1/file-1',
      'etag-1',
    );
    expect(storage.putOutput).toHaveBeenCalledWith(
      'outputs/batch-1/file-1',
      Buffer.from('output-bytes'),
      'image/jpeg',
    );
    expect(events.publish).toHaveBeenNthCalledWith(2, {
      type: 'RESULT',
      fileId: 'file-1',
      batchId: 'batch-1',
      attempt: 2,
      outcome: 'COMPLETED',
      resultKind: 'SAVED',
      inputFormat: 'jpeg',
      frameCount: 1,
      outputObjectKey: 'outputs/batch-1/file-1',
      outputBytes: 12,
      outputChecksum: createHash('sha256')
        .update(Buffer.from('output-bytes'))
        .digest('hex'),
      outputFormat: 'jpeg',
      width: 10,
      height: 20,
    });
    expect(sentCommands()).toContain('DeleteMessageCommand');
  });

  it('records a deterministic compression failure and deletes the message', async () => {
    compressor.compress.mockResolvedValue({
      ok: false,
      failureCode: 'UNSUPPORTED_FORMAT',
    });

    await handle()(QUEUE_URL, message());

    expect(storage.putOutput).not.toHaveBeenCalled();
    expect(events.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'RESULT',
        outcome: 'FAILED',
        failureCode: 'UNSUPPORTED_FORMAT',
      }),
    );
    expect(sentCommands()).toContain('DeleteMessageCommand');
  });

  it('records an input integrity failure and deletes the message', async () => {
    storage.getInput.mockRejectedValue(
      new InputIntegrityError('INPUT_CHANGED'),
    );

    await handle()(QUEUE_URL, message());

    expect(compressor.compress).not.toHaveBeenCalled();
    expect(events.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: 'FAILED',
        failureCode: 'INPUT_CHANGED',
      }),
    );
    expect(sentCommands()).toContain('DeleteMessageCommand');
  });

  it('leaves the message for redelivery on a transient storage failure', async () => {
    storage.getInput.mockRejectedValue(new Error('socket hang up'));

    await expect(handle()(QUEUE_URL, message())).rejects.toThrow(
      'socket hang up',
    );

    expect(events.publish).toHaveBeenCalledTimes(1);
    expect(events.publish).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'STARTED' }),
    );
    expect(sentCommands()).not.toContain('DeleteMessageCommand');
  });

  it.each([
    ['a wrong field type', '{"fileId": 42}'],
    ['a JSON null', 'null'],
    ['unparseable bytes', 'not json'],
  ])(
    'leaves a message with %s for redrive without publishing events',
    async (_case, body) => {
      await handle()(QUEUE_URL, message({ Body: body }));

      expect(events.publish).not.toHaveBeenCalled();
      expect(sentCommands()).not.toContain('DeleteMessageCommand');
    },
  );

  it('grants the processing slot to the highest waiting priority first', async () => {
    const internals = service as unknown as {
      acquire: (priority: number) => Promise<void>;
      release: () => void;
    };
    const order: number[] = [];

    await internals.acquire(3);
    const waiters = [
      internals.acquire(2).then(() => order.push(2)),
      internals.acquire(0).then(() => order.push(0)),
      internals.acquire(1).then(() => order.push(1)),
    ];
    await new Promise((resolve) => setImmediate(resolve));

    internals.release();
    internals.release();
    internals.release();
    await Promise.all(waiters);

    expect(order).toEqual([0, 1, 2]);
  });

  it('grants a starved low-priority waiter within the anti-starvation period', async () => {
    const internals = service as unknown as {
      acquire: (priority: number) => Promise<void>;
      release: () => void;
    };
    const grantOrder: number[] = [];
    const granted = (priority: number) => () => {
      grantOrder.push(priority);
      internals.release();
    };

    await internals.acquire(0);
    const waiters = [internals.acquire(3).then(granted(3))];
    for (let index = 0; index < 10; index++) {
      waiters.push(internals.acquire(0).then(granted(0)));
    }
    internals.release();
    await Promise.all(waiters);

    expect(grantOrder.indexOf(3)).toBeLessThan(8);
  });
});
