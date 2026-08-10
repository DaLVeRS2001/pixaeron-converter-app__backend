import { Metadata, type CallOptions } from '@grpc/grpc-js';
import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ClientGrpc } from '@nestjs/microservices';
import {
  NOTIFICATIONS_EMAIL_SERVICE_NAME,
  type NotificationsEmailServiceClient,
  type SendSecurityEmailRequest,
  type SendSecurityEmailResponse,
} from '@pixaeron/notifications-contract';
import { firstValueFrom } from 'rxjs';

export const NOTIFICATIONS_GRPC_CLIENT = Symbol('NOTIFICATIONS_GRPC_CLIENT');

const DEFAULT_NOTIFICATIONS_GRPC_DEADLINE_MS = 2_000;

@Injectable()
export class NotificationsEmailClient implements OnModuleInit {
  private readonly deadlineMs: number;
  private emailService!: NotificationsEmailServiceClient;

  constructor(
    @Inject(NOTIFICATIONS_GRPC_CLIENT)
    private readonly client: ClientGrpc,
    configService: ConfigService,
  ) {
    const configuredDeadlineMs = configService.get<string>(
      'NOTIFICATIONS_GRPC_DEADLINE_MS',
    );
    this.deadlineMs = Number(
      configuredDeadlineMs ?? DEFAULT_NOTIFICATIONS_GRPC_DEADLINE_MS,
    );
  }

  onModuleInit(): void {
    this.emailService = this.client.getService<NotificationsEmailServiceClient>(
      NOTIFICATIONS_EMAIL_SERVICE_NAME,
    );
  }

  sendSecurityEmail(
    request: SendSecurityEmailRequest,
  ): Promise<SendSecurityEmailResponse> {
    const options: CallOptions = {
      deadline: new Date(Date.now() + this.deadlineMs),
    };

    return firstValueFrom(
      this.emailService.sendSecurityEmail(request, new Metadata(), options),
    );
  }
}
