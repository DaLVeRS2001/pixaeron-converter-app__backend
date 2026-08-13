import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { PrismaModule } from '../prisma/prisma.module';
import { EntitlementsAuthenticationGuard } from './entitlements-authentication.guard';
import { EntitlementsController } from './entitlements.controller';
import { PlanService } from './plan.service';

@Module({
  imports: [ConfigModule, PrismaModule],
  controllers: [EntitlementsController],
  providers: [EntitlementsAuthenticationGuard, PlanService],
})
export class EntitlementsModule {}
