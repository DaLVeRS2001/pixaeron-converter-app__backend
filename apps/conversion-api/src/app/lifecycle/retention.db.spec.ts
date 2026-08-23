import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import {
  ConversionBatchStatus,
  ConversionFileStatus,
  ConversionPlanCode,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RetentionService } from './retention.service';

const HOUR_MS = 60 * 60 * 1000;

describe('RetentionService on Postgres', () => {
  let prisma: PrismaService;
  let retention: RetentionService;
  let subjects: string[] = [];

  beforeAll(() => {
    prisma = new PrismaService(
      new ConfigService({ DATABASE_URL: process.env['DATABASE_URL'] }),
    );
    retention = new RetentionService(prisma);
  });

  afterEach(async () => {
    await prisma.conversionBatch.deleteMany({
      where: { subject: { in: subjects } },
    });
    await prisma.dailyUsage.deleteMany({
      where: { subject: { in: subjects } },
    });
    subjects = [];
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const seedBatch = async (
    batchStatus: ConversionBatchStatus,
    files: Array<{ status: ConversionFileStatus; expiresInHours: number }>,
    batchExpiresInHours = -1,
  ) => {
    const subject = `anon:${randomUUID()}`;
    subjects.push(subject);
    const batchId = randomUUID();

    return prisma.conversionBatch.create({
      data: {
        id: batchId,
        subject,
        idempotencyKey: randomUUID(),
        planCode: ConversionPlanCode.ANONYMOUS,
        planRevision: 1,
        status: batchStatus,
        fileCount: files.length,
        expiresAt: new Date(Date.now() + batchExpiresInHours * HOUR_MS),
        files: {
          create: files.map((file) => {
            const fileId = randomUUID();
            return {
              id: fileId,
              status: file.status,
              inputObjectKey: `inputs/${batchId}/${fileId}`,
              expiresAt: new Date(Date.now() + file.expiresInHours * HOUR_MS),
            };
          }),
        },
      },
      include: { files: { orderBy: { id: 'asc' } } },
    });
  };

  const reload = async (batchId: string) =>
    prisma.conversionBatch.findUniqueOrThrow({
      where: { id: batchId },
      include: { files: { orderBy: { id: 'asc' } } },
    });

  it('expires a delivered result so history never links to deleted output', async () => {
    const batch = await seedBatch(ConversionBatchStatus.COMPLETED, [
      { status: ConversionFileStatus.COMPLETED, expiresInHours: -1 },
    ]);

    await retention.expireOverdueFiles();

    const expired = await reload(batch.id);
    expect(expired.files[0].status).toBe(ConversionFileStatus.EXPIRED);
    expect(expired.status).toBe(ConversionBatchStatus.EXPIRED);
  });

  it('closes an abandoned upload as EXPIRED', async () => {
    const batch = await seedBatch(ConversionBatchStatus.UPLOADING, [
      { status: ConversionFileStatus.UPLOADING, expiresInHours: -1 },
    ]);

    await retention.expireOverdueFiles();

    const expired = await reload(batch.id);
    expect(expired.files[0].status).toBe(ConversionFileStatus.EXPIRED);
    expect(expired.status).toBe(ConversionBatchStatus.EXPIRED);
  });

  it('expires an overdue file while the batch window is still open', async () => {
    const batch = await seedBatch(
      ConversionBatchStatus.QUEUED,
      [
        { status: ConversionFileStatus.COMPLETED, expiresInHours: -1 },
        { status: ConversionFileStatus.QUEUED, expiresInHours: 24 },
      ],
      24,
    );

    await retention.expireOverdueFiles();

    const swept = await reload(batch.id);
    expect(swept.files.map(({ status }) => status).sort()).toEqual([
      ConversionFileStatus.EXPIRED,
      ConversionFileStatus.QUEUED,
    ]);
    expect(swept.status).toBe(ConversionBatchStatus.QUEUED);
  });

  it('leaves a batch alone while its retention window is open', async () => {
    const batch = await seedBatch(
      ConversionBatchStatus.QUEUED,
      [{ status: ConversionFileStatus.QUEUED, expiresInHours: 24 }],
      24,
    );

    await retention.expireOverdueFiles();

    const untouched = await reload(batch.id);
    expect(untouched.files[0].status).toBe(ConversionFileStatus.QUEUED);
    expect(untouched.status).toBe(ConversionBatchStatus.QUEUED);
  });

  it('reports a partly delivered batch as PARTIAL once the rest expires', async () => {
    const batch = await seedBatch(ConversionBatchStatus.PROCESSING, [
      { status: ConversionFileStatus.COMPLETED, expiresInHours: 24 },
      { status: ConversionFileStatus.QUEUED, expiresInHours: -1 },
    ]);

    await retention.expireOverdueFiles();

    const swept = await reload(batch.id);
    expect(swept.files.map(({ status }) => status).sort()).toEqual([
      ConversionFileStatus.COMPLETED,
      ConversionFileStatus.EXPIRED,
    ]);
    expect(swept.status).toBe(ConversionBatchStatus.PARTIAL);
  });

  it('keeps a delivered outcome when the surviving result expires', async () => {
    const batch = await seedBatch(ConversionBatchStatus.PARTIAL, [
      { status: ConversionFileStatus.COMPLETED, expiresInHours: -1 },
      { status: ConversionFileStatus.FAILED, expiresInHours: -1 },
    ]);

    await retention.expireOverdueFiles();

    const swept = await reload(batch.id);
    expect(swept.files.map(({ status }) => status).sort()).toEqual([
      ConversionFileStatus.EXPIRED,
      ConversionFileStatus.FAILED,
    ]);
    expect(swept.status).toBe(ConversionBatchStatus.PARTIAL);
  });

  it('is idempotent across repeated sweeps', async () => {
    const batch = await seedBatch(ConversionBatchStatus.QUEUED, [
      { status: ConversionFileStatus.QUEUED, expiresInHours: -1 },
    ]);

    await retention.expireOverdueFiles();
    const first = await reload(batch.id);
    await retention.expireOverdueFiles();
    const second = await reload(batch.id);

    expect(second.status).toBe(first.status);
    expect(second.files[0].updatedAt).toEqual(first.files[0].updatedAt);
  });

  const WEEK_HOURS = 7 * 24;

  it('purges a batch a week after everything in it is dead', async () => {
    const batch = await seedBatch(
      ConversionBatchStatus.EXPIRED,
      [
        {
          status: ConversionFileStatus.EXPIRED,
          expiresInHours: -WEEK_HOURS - 1,
        },
      ],
      -WEEK_HOURS - 1,
    );

    await retention.purgeDeadRows();

    expect(
      await prisma.conversionBatch.findUnique({ where: { id: batch.id } }),
    ).toBeNull();
    expect(
      await prisma.conversionFile.count({ where: { batchId: batch.id } }),
    ).toBe(0);
  });

  it('keeps a dead batch inside the grace week', async () => {
    const batch = await seedBatch(
      ConversionBatchStatus.EXPIRED,
      [{ status: ConversionFileStatus.EXPIRED, expiresInHours: -1 }],
      -1,
    );

    await retention.purgeDeadRows();

    expect(await reload(batch.id)).toMatchObject({ id: batch.id });
  });

  it('never purges a batch that still holds a stored result', async () => {
    const batch = await seedBatch(
      ConversionBatchStatus.PARTIAL,
      [
        { status: ConversionFileStatus.COMPLETED, expiresInHours: 24 },
        {
          status: ConversionFileStatus.FAILED,
          expiresInHours: -WEEK_HOURS - 1,
        },
      ],
      -WEEK_HOURS - 1,
    );

    await retention.purgeDeadRows();

    expect((await reload(batch.id)).files).toHaveLength(2);
  });

  it('drops daily usage rows older than the grace week and keeps recent ones', async () => {
    const subject = `user:${randomUUID()}`;
    subjects.push(subject);
    const day = (daysAgo: number) => {
      const date = new Date();
      date.setUTCHours(0, 0, 0, 0);
      date.setUTCDate(date.getUTCDate() - daysAgo);
      return date;
    };
    await prisma.dailyUsage.createMany({
      data: [
        { subject, usageDate: day(0), admittedFiles: 3 },
        { subject, usageDate: day(30), admittedFiles: 9 },
      ],
    });

    await retention.purgeDeadRows();

    const remaining = await prisma.dailyUsage.findMany({ where: { subject } });
    expect(remaining.map(({ admittedFiles }) => admittedFiles)).toEqual([3]);
  });
});
