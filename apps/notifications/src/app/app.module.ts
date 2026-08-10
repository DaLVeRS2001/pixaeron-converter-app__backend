import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { notificationsEnvironmentSchema } from './config/notifications-environment.schema';
import { DeliveryModule } from './delivery/delivery.module';
import { FeedbackModule } from './feedback/feedback.module';
import { HealthController } from './health.controller';
import { OperationsModule } from './operations/operations.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: notificationsEnvironmentSchema,
      validationOptions: {
        abortEarly: false,
        allowUnknown: true,
      },
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    DeliveryModule,
    FeedbackModule,
    OperationsModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
