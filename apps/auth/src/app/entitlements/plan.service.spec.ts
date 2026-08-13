import { status as grpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';

import { PlanCode } from '../../generated/prisma/client';
import { PlanService } from './plan.service';

const SUBJECT = '0198f687-15d8-7f5e-bd79-62f8f4d51e08';

const freePlan = {
  code: PlanCode.FREE,
  revision: 1,
  effectiveFrom: new Date('2026-08-13T00:00:00Z'),
  priceCentsMonthly: null,
  maxBatchFiles: 5,
  maxFileBytes: BigInt(10485760),
  dailyFiles: 50,
  maxConcurrentFiles: 1,
  queueTier: 1,
  minStartDelayMs: 0,
  createdAt: new Date('2026-08-13T00:00:00Z'),
};

const rpcCode = (error: unknown) =>
  (error as RpcException).getError() as { code: number };

describe('PlanService', () => {
  const prisma = {
    plan: { findFirst: jest.fn() },
    user: { findUnique: jest.fn() },
  };
  let service: PlanService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new PlanService(prisma as never);
    prisma.plan.findFirst.mockResolvedValue(freePlan);
  });

  it('reads a plan once and serves the cached row within the TTL', async () => {
    await expect(service.getLatestPlan(PlanCode.FREE)).resolves.toBe(freePlan);
    await expect(service.getLatestPlan(PlanCode.FREE)).resolves.toBe(freePlan);

    expect(prisma.plan.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.plan.findFirst).toHaveBeenCalledWith({
      where: { code: PlanCode.FREE, effectiveFrom: { lte: expect.any(Date) } },
      orderBy: { revision: 'desc' },
    });
  });

  it('caches plan codes independently', async () => {
    await service.getLatestPlan(PlanCode.FREE);
    await service.getLatestPlan(PlanCode.ANONYMOUS);

    expect(prisma.plan.findFirst).toHaveBeenCalledTimes(2);
  });

  it('fails with INTERNAL when a plan has no effective definition', async () => {
    prisma.plan.findFirst.mockResolvedValue(null);

    const outcome = service.getLatestPlan(PlanCode.PRO);

    await expect(outcome).rejects.toBeInstanceOf(RpcException);
    await outcome.catch((error) => {
      expect(rpcCode(error).code).toBe(grpcStatus.INTERNAL);
    });
  });

  it('resolves a subject through its user plan code', async () => {
    prisma.user.findUnique.mockResolvedValue({ planCode: PlanCode.FREE });

    await expect(service.getPlanForSubject(SUBJECT)).resolves.toBe(freePlan);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { publicId: SUBJECT },
      select: { planCode: true },
    });
  });

  it('rejects a malformed subject before touching the database', async () => {
    const outcome = service.getPlanForSubject('not-a-uuid');

    await expect(outcome).rejects.toBeInstanceOf(RpcException);
    await outcome.catch((error) => {
      expect(rpcCode(error).code).toBe(grpcStatus.INVALID_ARGUMENT);
    });
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects an unknown subject with NOT_FOUND', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    const outcome = service.getPlanForSubject(SUBJECT);

    await expect(outcome).rejects.toBeInstanceOf(RpcException);
    await outcome.catch((error) => {
      expect(rpcCode(error).code).toBe(grpcStatus.NOT_FOUND);
    });
  });
});
