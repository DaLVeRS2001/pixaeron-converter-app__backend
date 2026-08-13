import { status as grpcStatus } from '@grpc/grpc-js';
import { Injectable } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';

import { PlanCode, type Plan } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const PLAN_CACHE_TTL_MS = 60_000;
const SUBJECT_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PlanService {
  private readonly cache = new Map<
    PlanCode,
    { plan: Plan; expiresAt: number }
  >();

  constructor(private readonly prisma: PrismaService) {}

  async getPlanForSubject(subject: string): Promise<Plan> {
    if (!SUBJECT_PATTERN.test(subject)) {
      throw new RpcException({
        code: grpcStatus.INVALID_ARGUMENT,
        message: 'Subject must be an opaque public identifier',
      });
    }

    const user = await this.prisma.user.findUnique({
      where: { publicId: subject },
      select: { planCode: true },
    });
    if (!user) {
      throw new RpcException({
        code: grpcStatus.NOT_FOUND,
        message: 'Unknown subject',
      });
    }

    return this.getLatestPlan(user.planCode);
  }

  async getLatestPlan(code: PlanCode): Promise<Plan> {
    const cached = this.cache.get(code);
    if (cached && cached.expiresAt > Date.now()) return cached.plan;

    const plan = await this.prisma.plan.findFirst({
      where: { code, effectiveFrom: { lte: new Date() } },
      orderBy: { revision: 'desc' },
    });
    if (!plan) {
      throw new RpcException({
        code: grpcStatus.INTERNAL,
        message: `Plan ${code} has no effective definition`,
      });
    }

    this.cache.set(code, { plan, expiresAt: Date.now() + PLAN_CACHE_TTL_MS });
    return plan;
  }
}
