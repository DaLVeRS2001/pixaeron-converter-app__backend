import { ConfigService } from '@nestjs/config';
import type {
  WorkerResultEvent,
  WorkerStartedEvent,
} from '@pixaeron/conversion-contract';
import { createHash, randomUUID } from 'node:crypto';

import {
  ConversionBatchStatus,
  ConversionFileStatus,
  ConversionPlanCode,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { InputObjectStorageService } from '../storage/input-object-storage.service';
import { WorkerEventProcessorService } from './worker-event-processor.service';

const OUTPUT_BYTES = Buffer.from('compressed-bytes');
const CHECKSUM = createHash('sha256').update(OUTPUT_BYTES).digest('base64');

describe('WorkerEventProcessorService on Postgres', () => {
  let prisma: PrismaService;
  let storage: { head: jest.Mock };
  let processor: WorkerEventProcessorService;
  let subjects: string[] = [];

  beforeAll(() => {
    prisma = new PrismaService(
      new ConfigService({ DATABASE_URL: process.env['DATABASE_URL'] }),
    );
    storage = { head: jest.fn() };
    processor = new WorkerEventProcessorService(
      prisma,
      storage as unknown as InputObjectStorageService,
    );
  });

  beforeEach(() => {
    storage.head.mockReset();
    storage.head.mockResolvedValue({
      bytes: OUTPUT_BYTES.length,
      checksumSha256: CHECKSUM,
    });
  });

  afterEach(async () => {
    await prisma.conversionBatch.deleteMany({
      where: { subject: { in: subjects } },
    });
    subjects = [];
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const seedBatch = async (fileCount: number) => {
    const subject = `anon:${randomUUID()}`;
    subjects.push(subject);
    const batchId = randomUUID();
    const expiresAt = new Date(Date.now() + 3_600_000);
    const batch = await prisma.conversionBatch.create({
      data: {
        id: batchId,
        subject,
        idempotencyKey: randomUUID(),
        planCode: ConversionPlanCode.ANONYMOUS,
        planRevision: 1,
        status: ConversionBatchStatus.QUEUED,
        fileCount,
        expiresAt,
        files: {
          create: Array.from({ length: fileCount }, () => {
            const fileId = randomUUID();
            return {
              id: fileId,
              status: ConversionFileStatus.QUEUED,
              inputObjectKey: `inputs/${batchId}/${fileId}`,
              inputEtag: 'etag',
              inputBytes: BigInt(2048),
              expiresAt,
            };
          }),
        },
      },
      include: { files: { orderBy: { id: 'asc' } } },
    });

    return batch;
  };

  const startedEvent = (
    batchId: string,
    fileId: string,
    attempt = 1,
  ): WorkerStartedEvent => ({ type: 'STARTED', batchId, fileId, attempt });

  const completedEvent = (
    batchId: string,
    fileId: string,
    attempt = 1,
  ): Extract<WorkerResultEvent, { outcome: 'COMPLETED' }> => ({
    type: 'RESULT',
    batchId,
    fileId,
    attempt,
    outcome: 'COMPLETED',
    resultKind: 'SAVED',
    inputFormat: 'jpeg',
    frameCount: 1,
    outputObjectKey: `outputs/${batchId}/${fileId}/${attempt}`,
    outputBytes: OUTPUT_BYTES.length,
    outputChecksumSha256: CHECKSUM,
    outputFormat: 'jpeg',
    width: 10,
    height: 20,
  });

  const failedEvent = (
    batchId: string,
    fileId: string,
    attempt = 1,
  ): WorkerResultEvent => ({
    type: 'RESULT',
    batchId,
    fileId,
    attempt,
    outcome: 'FAILED',
    failureCode: 'UNSUPPORTED_FORMAT',
  });

  const fileStatus = async (fileId: string) =>
    prisma.conversionFile.findUniqueOrThrow({ where: { id: fileId } });

  const batchStatus = async (batchId: string) =>
    (await prisma.conversionBatch.findUniqueOrThrow({ where: { id: batchId } }))
      .status;

  it('moves the file and its batch into PROCESSING on the first STARTED', async () => {
    const batch = await seedBatch(1);

    await processor.apply(startedEvent(batch.id, batch.files[0].id));

    const file = await fileStatus(batch.files[0].id);
    expect(file.status).toBe(ConversionFileStatus.PROCESSING);
    expect(file.attempt).toBe(1);
    expect(file.startedAt).not.toBeNull();
    expect(await batchStatus(batch.id)).toBe(ConversionBatchStatus.PROCESSING);
  });

  it('ignores a duplicate STARTED for the same attempt', async () => {
    const batch = await seedBatch(1);
    const event = startedEvent(batch.id, batch.files[0].id);

    await processor.apply(event);
    const first = await fileStatus(batch.files[0].id);
    await processor.apply(event);
    const second = await fileStatus(batch.files[0].id);

    expect(second.startedAt).toEqual(first.startedAt);
    expect(second.attempt).toBe(1);
  });

  it('records a verified result and completes the batch', async () => {
    const batch = await seedBatch(1);
    await processor.apply(startedEvent(batch.id, batch.files[0].id));

    await processor.apply(completedEvent(batch.id, batch.files[0].id));

    const file = await fileStatus(batch.files[0].id);
    expect(file).toMatchObject({
      status: ConversionFileStatus.COMPLETED,
      resultKind: 'SAVED',
      outputFormat: 'jpeg',
      inputFormat: 'jpeg',
      frameCount: 1,
      width: 10,
      height: 20,
    });
    expect(Number(file.outputBytes)).toBe(OUTPUT_BYTES.length);
    expect(file.outputChecksum).toBe(CHECKSUM);
    expect(await batchStatus(batch.id)).toBe(ConversionBatchStatus.COMPLETED);
  });

  it('ignores a replayed result once the file is terminal', async () => {
    const batch = await seedBatch(1);
    await processor.apply(completedEvent(batch.id, batch.files[0].id));
    const completedAt = (await fileStatus(batch.files[0].id)).completedAt;

    await processor.apply(completedEvent(batch.id, batch.files[0].id));

    expect((await fileStatus(batch.files[0].id)).completedAt).toEqual(
      completedAt,
    );
  });

  it('ignores a result from a superseded attempt', async () => {
    const batch = await seedBatch(1);
    await processor.apply(startedEvent(batch.id, batch.files[0].id, 2));

    await processor.apply(completedEvent(batch.id, batch.files[0].id, 1));

    expect((await fileStatus(batch.files[0].id)).status).toBe(
      ConversionFileStatus.PROCESSING,
    );
  });

  it.each([
    ['a missing output object', () => storage.head.mockResolvedValue(null)],
    [
      'a size that contradicts the event',
      () =>
        storage.head.mockResolvedValue({
          bytes: OUTPUT_BYTES.length + 1,
          checksumSha256: CHECKSUM,
        }),
    ],
    [
      'a checksum that contradicts the event',
      () =>
        storage.head.mockResolvedValue({
          bytes: OUTPUT_BYTES.length,
          checksumSha256: createHash('sha256').update('other').digest('base64'),
        }),
    ],
  ])('rejects a completion with %s', async (_case, arrange) => {
    const batch = await seedBatch(1);
    arrange();

    await expect(
      processor.apply(completedEvent(batch.id, batch.files[0].id)),
    ).rejects.toThrow();

    expect((await fileStatus(batch.files[0].id)).status).toBe(
      ConversionFileStatus.QUEUED,
    );
    expect(await batchStatus(batch.id)).toBe(ConversionBatchStatus.QUEUED);
  });

  it('rejects a completion claiming an output key of another file', async () => {
    const batch = await seedBatch(1);
    const event = completedEvent(batch.id, batch.files[0].id);

    await expect(
      processor.apply({ ...event, outputObjectKey: 'outputs/other/file' }),
    ).rejects.toThrow();
    expect(storage.head).not.toHaveBeenCalled();
  });

  it('marks the batch FAILED when every file failed', async () => {
    const batch = await seedBatch(2);

    for (const file of batch.files) {
      await processor.apply(failedEvent(batch.id, file.id));
    }

    expect(await batchStatus(batch.id)).toBe(ConversionBatchStatus.FAILED);
    const failed = await fileStatus(batch.files[0].id);
    expect(failed.failureCode).toBe('UNSUPPORTED_FORMAT');
    expect(failed.completedAt).not.toBeNull();
  });

  it('keeps a batch open while a file is still being uploaded', async () => {
    const batch = await seedBatch(2);
    await prisma.conversionFile.update({
      where: { id: batch.files[1].id },
      data: { status: ConversionFileStatus.UPLOADING },
    });

    await processor.apply(completedEvent(batch.id, batch.files[0].id));

    expect(await batchStatus(batch.id)).toBe(ConversionBatchStatus.QUEUED);
  });

  it('marks the batch PARTIAL when outcomes are mixed', async () => {
    const batch = await seedBatch(2);

    await processor.apply(completedEvent(batch.id, batch.files[0].id));
    expect(await batchStatus(batch.id)).toBe(ConversionBatchStatus.QUEUED);
    await processor.apply(failedEvent(batch.id, batch.files[1].id));

    expect(await batchStatus(batch.id)).toBe(ConversionBatchStatus.PARTIAL);
  });

  it('converges on one terminal batch status under concurrent results', async () => {
    const batch = await seedBatch(4);

    await Promise.all(
      batch.files.map((file) =>
        processor.apply(completedEvent(batch.id, file.id)),
      ),
    );

    expect(await batchStatus(batch.id)).toBe(ConversionBatchStatus.COMPLETED);
    const files = await prisma.conversionFile.findMany({
      where: { batchId: batch.id },
    });
    expect(
      files.every(({ status }) => status === ConversionFileStatus.COMPLETED),
    ).toBe(true);
  });
});
