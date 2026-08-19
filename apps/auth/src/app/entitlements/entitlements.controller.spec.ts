import { status as grpcStatus } from '@grpc/grpc-js';
import { RpcException } from '@nestjs/microservices';
import { EntitlementPlanCode } from '@pixaeron/entitlements-contract';

import { PlanCode } from '../../generated/prisma/client';
import { EntitlementsController } from './entitlements.controller';

const SUBJECT = '0198f687-15d8-7f5e-bd79-62f8f4d51e08';

const lightPlan = {
  code: PlanCode.LIGHT,
  revision: 3,
  effectiveFrom: new Date('2026-08-13T00:00:00Z'),
  priceCentsMonthly: 225,
  maxBatchFiles: 10,
  maxFileBytes: BigInt(78643200),
  dailyFiles: null,
  maxConcurrentFiles: 3,
  queueTier: 2,
  minStartDelayMs: 0,
  outputRetentionHours: 48,
  storageBytes: BigInt(2147483648),
  createdAt: new Date('2026-08-13T00:00:00Z'),
};

describe('EntitlementsController', () => {
  const planService = {
    getPlanForSubject: jest.fn(),
    getLatestPlan: jest.fn(),
  };
  const controller = new EntitlementsController(planService as never);

  beforeEach(() => jest.clearAllMocks());

  it('maps a subject plan row into the snapshot', async () => {
    planService.getPlanForSubject.mockResolvedValue(lightPlan);

    await expect(
      controller.getEntitlement({ subject: SUBJECT }),
    ).resolves.toEqual({
      snapshot: {
        planCode: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_LIGHT,
        revision: 3,
        effectiveFromEpochMs: lightPlan.effectiveFrom.getTime(),
        maxBatchFiles: 10,
        maxFileBytes: 78643200,
        dailyFiles: undefined,
        maxConcurrentFiles: 3,
        queueTier: 2,
        minStartDelayMs: 0,
        outputRetentionHours: 48,
        storageBytes: 2147483648,
      },
    });
    expect(planService.getPlanForSubject).toHaveBeenCalledWith(SUBJECT);
    expect(planService.getLatestPlan).not.toHaveBeenCalled();
  });

  it('serves the anonymous policy by plan code', async () => {
    planService.getLatestPlan.mockResolvedValue({
      ...lightPlan,
      code: PlanCode.ANONYMOUS,
      dailyFiles: 10,
    });

    await expect(
      controller.getEntitlement({
        planCode: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_ANONYMOUS,
      }),
    ).resolves.toMatchObject({
      snapshot: {
        planCode: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_ANONYMOUS,
        dailyFiles: 10,
      },
    });
    expect(planService.getLatestPlan).toHaveBeenCalledWith(PlanCode.ANONYMOUS);
  });

  it.each([
    ['an empty selector', {}],
    [
      'a registered plan code',
      { planCode: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_PRO },
    ],
  ])('rejects %s with INVALID_ARGUMENT', async (_case, request) => {
    const outcome = controller.getEntitlement(request);

    await expect(outcome).rejects.toBeInstanceOf(RpcException);
    await outcome.catch((error) => {
      expect((error as RpcException).getError()).toMatchObject({
        code: grpcStatus.INVALID_ARGUMENT,
      });
    });
    expect(planService.getPlanForSubject).not.toHaveBeenCalled();
    expect(planService.getLatestPlan).not.toHaveBeenCalled();
  });
});
