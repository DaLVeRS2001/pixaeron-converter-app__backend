import { status as grpcStatus } from '@grpc/grpc-js';
import { Controller, UseGuards } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import {
  EntitlementPlanCode,
  EntitlementsServiceControllerMethods,
  type EntitlementsServiceController,
  type GetEntitlementRequest,
  type GetEntitlementResponse,
} from '@pixaeron/entitlements-contract';

import { PlanCode, type Plan } from '../../generated/prisma/client';
import { EntitlementsAuthenticationGuard } from './entitlements-authentication.guard';
import { PlanService } from './plan.service';

const PLAN_CODE_TO_PROTO: Record<PlanCode, EntitlementPlanCode> = {
  [PlanCode.ANONYMOUS]: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_ANONYMOUS,
  [PlanCode.FREE]: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_FREE,
  [PlanCode.LIGHT]: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_LIGHT,
  [PlanCode.PRO]: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_PRO,
};

@Controller()
@UseGuards(EntitlementsAuthenticationGuard)
@EntitlementsServiceControllerMethods()
export class EntitlementsController implements EntitlementsServiceController {
  constructor(private readonly planService: PlanService) {}

  async getEntitlement(
    request: GetEntitlementRequest,
  ): Promise<GetEntitlementResponse> {
    const plan = await this.resolvePlan(request);

    return {
      snapshot: {
        planCode: PLAN_CODE_TO_PROTO[plan.code],
        revision: plan.revision,
        effectiveFromEpochMs: plan.effectiveFrom.getTime(),
        maxBatchFiles: plan.maxBatchFiles,
        maxFileBytes: Number(plan.maxFileBytes),
        dailyFiles: plan.dailyFiles ?? undefined,
        maxConcurrentFiles: plan.maxConcurrentFiles,
        queueTier: plan.queueTier,
        minStartDelayMs: plan.minStartDelayMs,
        outputRetentionHours: plan.outputRetentionHours,
      },
    };
  }

  private resolvePlan(request: GetEntitlementRequest): Promise<Plan> {
    if (request.subject !== undefined) {
      return this.planService.getPlanForSubject(request.subject);
    }

    if (
      request.planCode === EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_ANONYMOUS
    ) {
      return this.planService.getLatestPlan(PlanCode.ANONYMOUS);
    }

    throw new RpcException({
      code: grpcStatus.INVALID_ARGUMENT,
      message:
        'Entitlement lookup requires a subject or the anonymous plan code',
    });
  }
}
