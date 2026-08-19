import { ConfigService } from '@nestjs/config';

import { PlanCode } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PlanService } from './plan.service';

describe('plans seed on Postgres', () => {
  let prisma: PrismaService;

  beforeAll(() => {
    prisma = new PrismaService(
      new ConfigService({ DATABASE_URL: process.env['DATABASE_URL'] }),
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('holds the launch limit matrix for all four codes', async () => {
    const plans = await prisma.plan.findMany({
      where: { revision: 1 },
      orderBy: { queueTier: 'asc' },
    });

    expect(
      plans.map((plan) => ({
        code: plan.code,
        priceCentsMonthly: plan.priceCentsMonthly,
        maxBatchFiles: plan.maxBatchFiles,
        maxFileBytes: Number(plan.maxFileBytes),
        dailyFiles: plan.dailyFiles,
        maxConcurrentFiles: plan.maxConcurrentFiles,
        queueTier: plan.queueTier,
        minStartDelayMs: plan.minStartDelayMs,
        outputRetentionHours: plan.outputRetentionHours,
        storageBytes: plan.storageBytes,
      })),
    ).toEqual([
      {
        code: PlanCode.ANONYMOUS,
        priceCentsMonthly: null,
        maxBatchFiles: 3,
        maxFileBytes: 5 * 1024 * 1024,
        dailyFiles: 10,
        maxConcurrentFiles: 1,
        queueTier: 0,
        minStartDelayMs: 0,
        outputRetentionHours: 1,
        storageBytes: null,
      },
      {
        code: PlanCode.FREE,
        priceCentsMonthly: null,
        maxBatchFiles: 5,
        maxFileBytes: 10 * 1024 * 1024,
        dailyFiles: 50,
        maxConcurrentFiles: 1,
        queueTier: 1,
        minStartDelayMs: 0,
        outputRetentionHours: 48,
        storageBytes: BigInt(1073741824),
      },
      {
        code: PlanCode.LIGHT,
        priceCentsMonthly: 225,
        maxBatchFiles: 10,
        maxFileBytes: 50 * 1024 * 1024,
        dailyFiles: null,
        maxConcurrentFiles: 3,
        queueTier: 2,
        minStartDelayMs: 0,
        outputRetentionHours: 96,
        storageBytes: BigInt(2147483648),
      },
      {
        code: PlanCode.PRO,
        priceCentsMonthly: 1000,
        maxBatchFiles: 20,
        maxFileBytes: 150 * 1024 * 1024,
        dailyFiles: null,
        maxConcurrentFiles: 8,
        queueTier: 3,
        minStartDelayMs: 0,
        outputRetentionHours: 168,
        storageBytes: BigInt(10737418240),
      },
    ]);
  });

  it('serves the highest effective revision and ignores future rows', async () => {
    const service = new PlanService(prisma);
    await prisma.plan.create({
      data: {
        code: PlanCode.LIGHT,
        revision: 2,
        maxBatchFiles: 12,
        maxFileBytes: 50 * 1024 * 1024,
        maxConcurrentFiles: 3,
        queueTier: 2,
        minStartDelayMs: 0,
        outputRetentionHours: 48,
      },
    });
    await prisma.plan.create({
      data: {
        code: PlanCode.LIGHT,
        revision: 3,
        effectiveFrom: new Date(Date.now() + 86_400_000),
        maxBatchFiles: 99,
        maxFileBytes: 50 * 1024 * 1024,
        maxConcurrentFiles: 3,
        queueTier: 2,
        minStartDelayMs: 0,
        outputRetentionHours: 48,
      },
    });

    try {
      const plan = await service.getLatestPlan(PlanCode.LIGHT);
      expect(plan.revision).toBe(2);
      expect(plan.maxBatchFiles).toBe(12);
    } finally {
      await prisma.plan.deleteMany({
        where: { code: PlanCode.LIGHT, revision: { gt: 1 } },
      });
    }
  });

  it('refuses ANONYMOUS as a user plan code', async () => {
    await expect(
      prisma.user.create({
        data: {
          email: `plans-seed-${Date.now()}@example.com`,
          username: 'plans-seed',
          planCode: PlanCode.ANONYMOUS,
        },
      }),
    ).rejects.toThrow(/users_plan_code_not_anonymous|constraint/i);
  });
});
