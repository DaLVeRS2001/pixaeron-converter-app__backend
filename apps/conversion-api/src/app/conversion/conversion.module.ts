import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ClientsModule, Transport } from '@nestjs/microservices';
import { ENTITLEMENTS_GRPC_LOADER } from '@pixaeron/entitlements-contract';
import { join } from 'node:path';

import { AdmissionService } from '../admission/admission.service';
import { UploadCompletionService } from '../admission/upload-completion.service';
import {
  ENTITLEMENTS_GRPC_CLIENT,
  EntitlementsClient,
} from '../entitlements/entitlements.client';
import { AnonymousIdentityService } from '../identity/anonymous-identity.service';
import { OutboxPublisherService } from '../outbox/outbox-publisher.service';
import { PrismaModule } from '../prisma/prisma.module';
import { InputObjectStorageService } from '../storage/input-object-storage.service';
import { ConversionResolver } from './conversion.resolver';

export const CONVERSION_RESOLVERS = [ConversionResolver];

const entitlementsProtoPath = join(
  __dirname,
  'proto/pixaeron/entitlements/v1/entitlements.proto',
);

@Module({
  imports: [
    ConfigModule,
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
  providers: [
    ...CONVERSION_RESOLVERS,
    AdmissionService,
    AnonymousIdentityService,
    EntitlementsClient,
    InputObjectStorageService,
    OutboxPublisherService,
    UploadCompletionService,
  ],
})
export class ConversionModule {}
