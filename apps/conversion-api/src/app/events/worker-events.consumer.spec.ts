import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';

import {
  parseWorkerEvent,
  WorkerEventsConsumer,
} from './worker-events.consumer';
import type { WorkerEventProcessorService } from './worker-event-processor.service';

const CHECKSUM = createHash('sha256').update('output').digest('base64');

const completedBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'RESULT',
    fileId: 'file-1',
    batchId: 'batch-1',
    attempt: 1,
    outcome: 'COMPLETED',
    resultKind: 'SAVED',
    inputFormat: 'jpeg',
    frameCount: 1,
    outputObjectKey: 'outputs/batch-1/file-1',
    outputBytes: 1024,
    outputChecksumSha256: CHECKSUM,
    outputFormat: 'jpeg',
    width: 10,
    height: 20,
    ...overrides,
  });

describe('parseWorkerEvent', () => {
  it('accepts a started event and keeps only the contract fields', () => {
    const body = JSON.stringify({
      type: 'STARTED',
      fileId: 'file-1',
      batchId: 'batch-1',
      attempt: 2,
      injected: 'ignored',
    });

    expect(parseWorkerEvent(body)).toEqual({
      type: 'STARTED',
      fileId: 'file-1',
      batchId: 'batch-1',
      attempt: 2,
    });
  });

  it('accepts a completed result', () => {
    expect(parseWorkerEvent(completedBody())).toMatchObject({
      outcome: 'COMPLETED',
      resultKind: 'SAVED',
      outputChecksumSha256: CHECKSUM,
    });
  });

  it('accepts a failed result', () => {
    const body = JSON.stringify({
      type: 'RESULT',
      fileId: 'file-1',
      batchId: 'batch-1',
      attempt: 1,
      outcome: 'FAILED',
      failureCode: 'DECODE_FAILED',
    });

    expect(parseWorkerEvent(body)).toEqual({
      type: 'RESULT',
      fileId: 'file-1',
      batchId: 'batch-1',
      attempt: 1,
      outcome: 'FAILED',
      failureCode: 'DECODE_FAILED',
    });
  });

  it.each([
    ['unparseable bytes', 'not json'],
    ['a JSON null', 'null'],
    ['an array', '[1,2]'],
    ['an unknown type', JSON.stringify({ type: 'PING', fileId: 'f' })],
    ['a missing file id', completedBody({ fileId: '' })],
    ['a zero attempt', completedBody({ attempt: 0 })],
    ['a fractional attempt', completedBody({ attempt: 1.5 })],
    ['a numeric attempt sent as text', completedBody({ attempt: '1' })],
    ['an unknown result kind', completedBody({ resultKind: 'SHRUNK' })],
    ['a malformed checksum', completedBody({ outputChecksumSha256: 'nope' })],
    ['a missing checksum', completedBody({ outputChecksumSha256: '' })],
    ['a negative output size', completedBody({ outputBytes: -1 })],
    ['a failed result without a code', completedBody({ outcome: 'FAILED' })],
    ['an unknown outcome', completedBody({ outcome: 'MAYBE' })],
  ])('rejects %s', (_case, body) => {
    expect(parseWorkerEvent(body)).toBeNull();
  });
});

describe('WorkerEventsConsumer', () => {
  let client: { send: jest.Mock; destroy: jest.Mock };
  let processor: { apply: jest.Mock };
  let consumer: WorkerEventsConsumer;

  beforeEach(() => {
    client = { send: jest.fn().mockResolvedValue({}), destroy: jest.fn() };
    processor = { apply: jest.fn().mockResolvedValue(undefined) };
    consumer = new WorkerEventsConsumer(
      processor as unknown as WorkerEventProcessorService,
      new ConfigService({
        AWS_REGION: 'eu-central-1',
        AWS_ACCOUNT_ID: '123456789012',
        AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE',
        AWS_SECRET_ACCESS_KEY:
          'example-secret-access-key-that-is-40-characters',
        SQS_QUEUE_SUFFIX: '-dev',
      }),
    );
    (consumer as unknown as { client: typeof client }).client = client;
  });

  const sentCommands = () =>
    client.send.mock.calls.map(([command]) => command.constructor.name);

  it('applies an accepted event and deletes the message', async () => {
    await consumer.handle({
      Body: completedBody(),
      ReceiptHandle: 'receipt-1',
    });

    expect(processor.apply).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'COMPLETED' }),
    );
    expect(sentCommands()).toContain('DeleteMessageCommand');
    const [command] = client.send.mock.calls[0];
    expect(command.input).toMatchObject({
      QueueUrl:
        'https://sqs.eu-central-1.amazonaws.com/123456789012/pixaeron-conversion-events-dev',
      ReceiptHandle: 'receipt-1',
    });
  });

  it('leaves an unverifiable event for redrive', async () => {
    processor.apply.mockRejectedValue(
      new Error('Output checksum contradicts the event'),
    );

    await expect(
      consumer.handle({ Body: completedBody(), ReceiptHandle: 'receipt-1' }),
    ).rejects.toThrow('contradicts');

    expect(sentCommands()).not.toContain('DeleteMessageCommand');
  });

  it('leaves a malformed event for redrive without touching the processor', async () => {
    await consumer.handle({ Body: 'not json', ReceiptHandle: 'receipt-1' });

    expect(processor.apply).not.toHaveBeenCalled();
    expect(sentCommands()).not.toContain('DeleteMessageCommand');
  });

  it('propagates a transient failure so the message stays invisible', async () => {
    processor.apply.mockRejectedValue(new Error('connection terminated'));

    await expect(
      consumer.handle({ Body: completedBody(), ReceiptHandle: 'receipt-1' }),
    ).rejects.toThrow('connection terminated');

    expect(sentCommands()).not.toContain('DeleteMessageCommand');
  });
});
