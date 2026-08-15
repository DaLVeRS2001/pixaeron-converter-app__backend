import { ConfigService } from '@nestjs/config';
import {
  EntitlementPlanCode,
  type EntitlementSnapshot,
} from '@pixaeron/entitlements-contract';
import { randomUUID } from 'node:crypto';

import {
  ConversionBatchStatus,
  ConversionFileStatus,
} from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AdmissionService } from './admission.service';

const LARGE_FILE_BYTES = 26214400;

const anonymousSnapshot: EntitlementSnapshot = {
  planCode: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_ANONYMOUS,
  revision: 1,
  effectiveFromEpochMs: 0,
  maxBatchFiles: 3,
  maxFileBytes: 5242880,
  dailyFiles: 10,
  maxConcurrentFiles: 1,
  queueTier: 0,
  minStartDelayMs: 0,
  outputRetentionHours: 48,
};

const proSnapshot: EntitlementSnapshot = {
  ...anonymousSnapshot,
  planCode: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_PRO,
  maxBatchFiles: 20,
  maxFileBytes: 157286400,
  dailyFiles: undefined,
  maxConcurrentFiles: 8,
  queueTier: 3,
};

describe('AdmissionService on Postgres', () => {
  let prisma: PrismaService;
  let service: AdmissionService;
  let subjects: string[] = [];
  let batchIds: string[] = [];

  beforeAll(() => {
    const configService = new ConfigService({
      DATABASE_URL: process.env['DATABASE_URL'],
      CONVERSION_LARGE_FILE_BYTES: String(LARGE_FILE_BYTES),
    });
    prisma = new PrismaService(configService);
    service = new AdmissionService(prisma, configService);
  });

  afterEach(async () => {
    for (const batchId of batchIds) {
      await prisma.outboxEvent.deleteMany({
        where: { payload: { path: ['batchId'], equals: batchId } },
      });
    }
    await prisma.conversionBatch.deleteMany({
      where: { subject: { in: subjects } },
    });
    await prisma.dailyUsage.deleteMany({
      where: { subject: { in: subjects } },
    });
    subjects = [];
    batchIds = [];
  });

  const outboxEventsForBatches = async () => {
    const events = await prisma.outboxEvent.findMany({});
    return events.filter(({ payload }) =>
      batchIds.includes((payload as { batchId: string }).batchId),
    );
  };

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const anonSubject = () => {
    const subject = `anon:${randomUUID()}`;
    subjects.push(subject);
    return subject;
  };

  const readyBatch = async (
    subject: string,
    snapshot: EntitlementSnapshot,
    fileCount: number,
    inputBytes = 1024,
  ) => {
    const created = await service.createBatch(
      {
        subject,
        anonymous:
          snapshot.planCode ===
          EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_ANONYMOUS,
        idempotencyKey: randomUUID(),
        fileCount,
      },
      snapshot,
    );
    batchIds.push(created.batch.id);
    await prisma.conversionFile.updateMany({
      where: { batchId: created.batch.id },
      data: {
        status: ConversionFileStatus.READY,
        inputBytes,
        inputEtag: 'etag',
      },
    });
    return created;
  };

  it('enforces the daily quota exactly under parallel admission', async () => {
    const subject = anonSubject();
    const batches = [];
    for (let i = 0; i < 4; i += 1) {
      batches.push(await readyBatch(subject, anonymousSnapshot, 3));
    }

    const outcomes = await Promise.allSettled(
      batches.map(({ batch, batchToken }) =>
        service.admitReadyFiles(
          batch.id,
          { subject, batchToken },
          anonymousSnapshot,
        ),
      ),
    );

    const admitted = outcomes.filter(
      (outcome) => outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome) => outcome.status === 'rejected',
    );
    expect(admitted).toHaveLength(3);
    expect(rejected).toHaveLength(1);
    for (const outcome of rejected) {
      expect(outcome.reason).toMatchObject({ code: 'DAILY_QUOTA_EXCEEDED' });
    }

    const usage = await prisma.dailyUsage.findFirstOrThrow({
      where: { subject },
      orderBy: { usageDate: 'desc' },
    });
    expect(usage.admittedFiles).toBe(9);

    const queuedFiles = await prisma.conversionFile.count({
      where: {
        batch: { subject },
        status: ConversionFileStatus.QUEUED,
      },
    });
    expect(queuedFiles).toBe(9);

    const events = await outboxEventsForBatches();
    expect(events).toHaveLength(9);
    expect(new Set(events.map(({ queue }) => queue))).toEqual(
      new Set(['pixaeron-conversion-anon']),
    );

    const rejectedIndex = outcomes.findIndex(
      (outcome) => outcome.status === 'rejected',
    );
    const rejectedBatch = await prisma.conversionBatch.findUniqueOrThrow({
      where: { id: batches[rejectedIndex].batch.id },
      include: { files: true },
    });
    expect(rejectedBatch.status).toBe(ConversionBatchStatus.UPLOADING);
    expect(rejectedBatch.files.map(({ status }) => status)).toEqual([
      ConversionFileStatus.READY,
      ConversionFileStatus.READY,
      ConversionFileStatus.READY,
    ]);
  });

  it('does not double-charge quota when the same batch is admitted twice', async () => {
    const subject = anonSubject();
    const { batch, batchToken } = await readyBatch(
      subject,
      anonymousSnapshot,
      2,
    );
    const ownership = { subject, batchToken };

    const [first, second] = await Promise.all([
      service.admitReadyFiles(batch.id, ownership, anonymousSnapshot),
      service.admitReadyFiles(batch.id, ownership, anonymousSnapshot),
    ]);

    expect([first.admittedFiles, second.admittedFiles].sort()).toEqual([0, 2]);

    const replay = await service.admitReadyFiles(
      batch.id,
      ownership,
      anonymousSnapshot,
    );
    expect(replay.admittedFiles).toBe(0);

    const usage = await prisma.dailyUsage.findFirstOrThrow({
      where: { subject },
      orderBy: { usageDate: 'desc' },
    });
    expect(usage.admittedFiles).toBe(2);
  });

  it('admits files that become ready after the first admission', async () => {
    const subject = anonSubject();
    const created = await service.createBatch(
      { subject, anonymous: true, idempotencyKey: randomUUID(), fileCount: 2 },
      anonymousSnapshot,
    );
    batchIds.push(created.batch.id);
    const ownership = { subject, batchToken: created.batchToken };
    const [firstFile, secondFile] = created.files;

    await prisma.conversionFile.update({
      where: { id: firstFile.id },
      data: {
        status: ConversionFileStatus.READY,
        inputBytes: 1024,
        inputEtag: 'etag',
      },
    });
    const first = await service.admitReadyFiles(
      created.batch.id,
      ownership,
      anonymousSnapshot,
    );
    expect(first.admittedFiles).toBe(1);

    await prisma.conversionFile.update({
      where: { id: secondFile.id },
      data: {
        status: ConversionFileStatus.READY,
        inputBytes: 1024,
        inputEtag: 'etag',
      },
    });
    const second = await service.admitReadyFiles(
      created.batch.id,
      ownership,
      anonymousSnapshot,
    );
    expect(second.admittedFiles).toBe(1);

    const usage = await prisma.dailyUsage.findFirstOrThrow({
      where: { subject },
      orderBy: { usageDate: 'desc' },
    });
    expect(usage.admittedFiles).toBe(2);
    await expect(outboxEventsForBatches()).resolves.toHaveLength(2);
  });

  it('hides a batch from a co-NAT visitor without the token', async () => {
    const subject = anonSubject();
    const { batch } = await readyBatch(subject, anonymousSnapshot, 1);

    await expect(
      service.admitReadyFiles(
        batch.id,
        { subject, batchToken: 'guessed-token' },
        anonymousSnapshot,
      ),
    ).rejects.toMatchObject({ code: 'BATCH_NOT_FOUND' });

    const untouched = await prisma.conversionBatch.findUniqueOrThrow({
      where: { id: batch.id },
    });
    expect(untouched.status).toBe(ConversionBatchStatus.UPLOADING);
  });

  it('replays anonymous creation only with the original token', async () => {
    const subject = anonSubject();
    const idempotencyKey = 'shared-nat-key';
    const first = await service.createBatch(
      { subject, anonymous: true, idempotencyKey, fileCount: 1 },
      anonymousSnapshot,
    );

    const replay = await service.createBatch(
      {
        subject,
        anonymous: true,
        idempotencyKey,
        fileCount: 1,
        batchToken: first.batchToken,
      },
      anonymousSnapshot,
    );
    expect(replay.replayed).toBe(true);
    expect(replay.batch.id).toBe(first.batch.id);
    expect(replay.batchToken).toBeNull();

    await expect(
      service.createBatch(
        {
          subject,
          anonymous: true,
          idempotencyKey,
          fileCount: 1,
          batchToken: 'someone-elses-guess',
        },
        anonymousSnapshot,
      ),
    ).rejects.toMatchObject({ code: 'BATCH_TOKEN_MISMATCH' });

    await expect(
      service.createBatch(
        {
          subject,
          anonymous: true,
          idempotencyKey,
          fileCount: 3,
          batchToken: first.batchToken,
        },
        anonymousSnapshot,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('skips daily usage for unlimited plans and routes large paid files separately', async () => {
    const subject = randomUUID();
    subjects.push(subject);
    const { batch } = await readyBatch(subject, proSnapshot, 2);
    await prisma.conversionFile.updateMany({
      where: { batchId: batch.id },
      data: { inputBytes: LARGE_FILE_BYTES + 1 },
    });
    const [small] = await prisma.conversionFile.findMany({
      where: { batchId: batch.id },
      orderBy: { inputObjectKey: 'asc' },
      take: 1,
    });
    await prisma.conversionFile.update({
      where: { id: small.id },
      data: { inputBytes: 1024 },
    });

    const result = await service.admitReadyFiles(
      batch.id,
      { subject },
      proSnapshot,
    );
    expect(result.admittedFiles).toBe(2);

    await expect(
      prisma.dailyUsage.findFirst({ where: { subject } }),
    ).resolves.toBeNull();

    const events = (await outboxEventsForBatches()).sort((a, b) =>
      a.queue.localeCompare(b.queue),
    );
    expect(events.map(({ queue }) => queue)).toEqual([
      'pixaeron-conversion-paid-large',
      'pixaeron-conversion-pro',
    ]);
  });

  it('stamps the paid retention window and marks the request extended', async () => {
    const snapshot = { ...proSnapshot, outputRetentionHours: 168 };
    const subject = randomUUID();
    subjects.push(subject);
    const { batch } = await readyBatch(subject, snapshot, 1);

    const result = await service.admitReadyFiles(
      batch.id,
      { subject },
      snapshot,
    );

    const window = result.batch.expiresAt.getTime() - Date.now();
    expect(window).toBeGreaterThan(167 * 60 * 60 * 1000);
    expect(window).toBeLessThanOrEqual(168 * 60 * 60 * 1000);

    const [file] = await prisma.conversionFile.findMany({
      where: { batchId: batch.id },
    });
    expect(file.expiresAt).toEqual(result.batch.expiresAt);

    const [event] = await outboxEventsForBatches();
    expect((event.payload as { outputRetention: string }).outputRetention).toBe(
      'extended',
    );
  });

  it('refuses admission when the plan carries an unmapped retention window', async () => {
    const snapshot = { ...anonymousSnapshot, outputRetentionHours: 0 };
    const subject = anonSubject();
    const { batch } = await readyBatch(subject, anonymousSnapshot, 1);

    await expect(
      service.admitReadyFiles(batch.id, { subject }, snapshot),
    ).rejects.toThrow(/Unmapped output retention 0h/);

    await expect(outboxEventsForBatches()).resolves.toHaveLength(0);
    const [file] = await prisma.conversionFile.findMany({
      where: { batchId: batch.id },
    });
    expect(file.status).toBe(ConversionFileStatus.READY);
  });
});
