import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { ConversionPlanCode } from '../generated/prisma/client';
import { PrismaService } from './prisma/prisma.service';

describe('conversion schema on Postgres', () => {
  let prisma: PrismaService;
  let batchIds: string[] = [];

  beforeAll(() => {
    prisma = new PrismaService(
      new ConfigService({ DATABASE_URL: process.env['DATABASE_URL'] }),
    );
  });

  afterEach(async () => {
    await prisma.conversionBatch.deleteMany({
      where: { id: { in: batchIds } },
    });
    batchIds = [];
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const createBatch = async (subject: string, idempotencyKey: string) => {
    const batch = await prisma.conversionBatch.create({
      data: {
        subject,
        idempotencyKey,
        planCode: ConversionPlanCode.FREE,
        planRevision: 1,
        fileCount: 1,
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    batchIds.push(batch.id);
    return batch;
  };

  it('rejects a duplicate idempotency key for the same subject only', async () => {
    const subject = randomUUID();
    await createBatch(subject, 'retry-key');

    await expect(createBatch(subject, 'retry-key')).rejects.toMatchObject({
      code: 'P2002',
      meta: { modelName: 'ConversionBatch' },
    });
    await expect(
      createBatch(`anon:${randomUUID()}`, 'retry-key'),
    ).resolves.toMatchObject({ idempotencyKey: 'retry-key' });
  });

  it('cascades file deletion with the batch and keeps object keys unique', async () => {
    const batch = await createBatch(randomUUID(), 'cascade-key');
    const inputObjectKey = `inputs/${batch.id}/${randomUUID()}`;
    await prisma.conversionFile.create({
      data: {
        batchId: batch.id,
        inputObjectKey,
        expiresAt: batch.expiresAt,
      },
    });

    await expect(
      prisma.conversionFile.create({
        data: {
          batchId: batch.id,
          inputObjectKey,
          expiresAt: batch.expiresAt,
        },
      }),
    ).rejects.toMatchObject({
      code: 'P2002',
      meta: { modelName: 'ConversionFile' },
    });

    await prisma.conversionBatch.delete({ where: { id: batch.id } });
    batchIds = batchIds.filter((id) => id !== batch.id);
    await expect(
      prisma.conversionFile.findMany({ where: { batchId: batch.id } }),
    ).resolves.toEqual([]);
  });

  it('accumulates daily usage per subject and day', async () => {
    const subject = `anon:${randomUUID()}`;
    const usageDate = new Date('2026-08-13T00:00:00Z');

    try {
      for (let i = 0; i < 5; i += 1) {
        await prisma.dailyUsage.upsert({
          where: { subject_usageDate: { subject, usageDate } },
          create: { subject, usageDate, admittedFiles: 1 },
          update: { admittedFiles: { increment: 1 } },
        });
      }

      const usage = await prisma.dailyUsage.findUniqueOrThrow({
        where: { subject_usageDate: { subject, usageDate } },
      });
      expect(usage.admittedFiles).toBe(5);
    } finally {
      await prisma.dailyUsage.deleteMany({ where: { subject } });
    }
  });
});
