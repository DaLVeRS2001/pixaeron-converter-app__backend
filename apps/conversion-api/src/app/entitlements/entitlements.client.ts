import { Metadata, type CallOptions } from '@grpc/grpc-js';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ClientGrpc } from '@nestjs/microservices';
import {
  ENTITLEMENTS_SERVICE_NAME,
  type EntitlementsServiceClient,
  type GetEntitlementRequest,
  type GetEntitlementResponse,
} from '@pixaeron/entitlements-contract';
import { firstValueFrom } from 'rxjs';

export const ENTITLEMENTS_GRPC_CLIENT = Symbol('ENTITLEMENTS_GRPC_CLIENT');
export const COMMAND_SECRET_METADATA_KEY = 'x-pixaeron-command-secret';

@Injectable()
export class EntitlementsClient implements OnModuleInit {
  private readonly deadlineMs: number;
  private readonly commandSecret: string | undefined;
  private entitlementsService!: EntitlementsServiceClient;

  constructor(
    @Inject(ENTITLEMENTS_GRPC_CLIENT)
    private readonly client: ClientGrpc,
    configService: ConfigService,
  ) {
    this.deadlineMs = Number(
      configService.getOrThrow<string>('ENTITLEMENTS_GRPC_DEADLINE_MS'),
    );
    this.commandSecret = configService.get<string>(
      'ENTITLEMENTS_COMMAND_SECRET',
    );
  }

  onModuleInit(): void {
    this.entitlementsService =
      this.client.getService<EntitlementsServiceClient>(
        ENTITLEMENTS_SERVICE_NAME,
      );
  }

  getEntitlement(
    request: GetEntitlementRequest,
  ): Promise<GetEntitlementResponse> {
    const options: CallOptions = {
      deadline: new Date(Date.now() + this.deadlineMs),
    };
    const metadata = new Metadata();
    if (this.commandSecret) {
      metadata.add(COMMAND_SECRET_METADATA_KEY, this.commandSecret);
    }

    return firstValueFrom(
      this.entitlementsService.getEntitlement(request, metadata, options),
    );
  }
}
