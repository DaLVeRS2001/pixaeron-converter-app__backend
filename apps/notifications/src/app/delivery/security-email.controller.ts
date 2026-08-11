import {
  NotificationsEmailServiceControllerMethods,
  SecurityEmailPurpose,
  type NotificationsEmailServiceController,
  type SendSecurityEmailRequest,
  type SendSecurityEmailResponse,
} from '@pixaeron/notifications-contract';
import { Controller, UseGuards } from '@nestjs/common';
import { RpcException } from '@nestjs/microservices';
import {
  status as grpcStatus,
  type Metadata,
  type ServerUnaryCall,
} from '@grpc/grpc-js';
import { isEmail, isUUID } from 'class-validator';

import { CommandAuthenticationGuard } from './command-authentication.guard';
import {
  EmailCommandConflictError,
  SecurityEmailService,
} from './security-email.service';

@Controller()
@UseGuards(CommandAuthenticationGuard)
@NotificationsEmailServiceControllerMethods()
export class SecurityEmailController
  implements NotificationsEmailServiceController
{
  constructor(private readonly securityEmailService: SecurityEmailService) {}

  async sendSecurityEmail(
    request: SendSecurityEmailRequest,
    _metadata: Metadata,
    call: ServerUnaryCall<SendSecurityEmailRequest, SendSecurityEmailResponse>,
  ): Promise<SendSecurityEmailResponse> {
    if (!isValidCommand(request)) {
      throw new RpcException({
        code: grpcStatus.INVALID_ARGUMENT,
        message: 'Invalid security email command',
      });
    }

    try {
      return await this.securityEmailService.send(request, readDeadline(call));
    } catch (error) {
      if (error instanceof EmailCommandConflictError) {
        throw new RpcException({
          code: grpcStatus.ALREADY_EXISTS,
          message: 'Request ID belongs to another command',
        });
      }

      throw error;
    }
  }
}

function isValidCommand(request: SendSecurityEmailRequest): boolean {
  const purposeIsSupported = [
    SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_EMAIL_VERIFICATION,
    SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_PASSWORD_RESET,
  ].includes(request.purpose);
  const recipient = request.recipient.trim();
  const tokenIsValid =
    request.token.length > 0 && request.token.length <= 2_048;

  return (
    isUUID(request.requestId, '4') &&
    isUUID(request.publicSubject) &&
    recipient.length <= 320 &&
    isEmail(recipient) &&
    purposeIsSupported &&
    tokenIsValid &&
    request.contentVersion === 1
  );
}

function readDeadline(
  call: ServerUnaryCall<SendSecurityEmailRequest, SendSecurityEmailResponse>,
): number {
  const deadline = call.getDeadline();
  const deadlineAt = deadline instanceof Date ? deadline.getTime() : deadline;

  return Number.isFinite(deadlineAt) ? deadlineAt : Infinity;
}
