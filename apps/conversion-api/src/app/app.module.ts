import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ENTITLEMENTS_GRPC_LOADER } from '@pixaeron/entitlements-contract';
import { join } from 'node:path';

import { AdmissionService } from './admission/admission.service';
import { conversionEnvironmentSchema } from './config/conversion-environment.schema';
import {
  ENTITLEMENTS_GRPC_CLIENT,
  EntitlementsClient,
} from './entitlements/entitlements.client';
import { HealthController } from './health.controller';
import { PrismaModule } from './prisma/prisma.module';

const entitlementsProtoPath = join(
  __dirname,
  'proto/pixaeron/entitlements/v1/entitlements.proto',
);

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validationSchema: conversionEnvironmentSchema,
      validationOptions: {
        abortEarly: false,
        allowUnknown: true,
      },
    }),
    ClientsModule.registerAsync([
      {
        name: ENTITLEMENTS_GRPC_CLIENT,
        imports: [ConfigModule],
        inject: [ConfigService],
        useFactory: (configService: ConfigService) => ({
          transport: Transport.GRPC,
          options: {
            package: 'pixaeron.entitlements.v1',
            protoPath: entitlementsProtoPath,
            url: configService.get<string>('ENTITLEMENTS_GRPC_URL'),
            loader: { ...ENTITLEMENTS_GRPC_LOADER },
            channelOptions: {
              'grpc.enable_retries': 0,
            },
          },
        }),
      },
    ]),
    PrismaModule,
  ],
  controllers: [HealthController],
  providers: [AdmissionService, EntitlementsClient],
})
export class AppModule {}
