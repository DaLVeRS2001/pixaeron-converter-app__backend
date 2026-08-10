import {
  SecurityEmailPurpose,
  SendSecurityEmailResult,
  type SendSecurityEmailRequest,
  type SendSecurityEmailResponse,
} from '@pixaeron/notifications-contract';
import {
  Metadata,
  status as grpcStatus,
  type ServerUnaryCall,
} from '@grpc/grpc-js';

import { SecurityEmailController } from './security-email.controller';
import { SecurityEmailService } from './security-email.service';

const validRequest: SendSecurityEmailRequest = {
  requestId: '123e4567-e89b-42d3-a456-426614174000',
  publicSubject: '0198f687-15d8-7f5e-bd79-62f8f4d51e08',
  recipient: 'user@example.com',
  purpose: SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_EMAIL_VERIFICATION,
  token: 'verification-token',
  contentVersion: 1,
};

describe('SecurityEmailController', () => {
  it('accepts a UUID v4 command request ID', async () => {
    const response: SendSecurityEmailResponse = {
      result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_ACCEPTED,
      code: undefined,
    };
    const send = jest.fn().mockResolvedValue(response);
    const controller = createController(send);

    await expect(
      controller.sendSecurityEmail(validRequest, new Metadata(), createCall()),
    ).resolves.toEqual(response);
    expect(send).toHaveBeenCalledWith(validRequest, expect.any(Number));
  });

  it('passes Infinity, not an expired budget, when the caller has no deadline', async () => {
    const response: SendSecurityEmailResponse = {
      result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_ACCEPTED,
      code: undefined,
    };
    const send = jest.fn().mockResolvedValue(response);
    const controller = createController(send);
    const call = {
      getDeadline: () => Infinity,
    } as unknown as ServerUnaryCall<
      SendSecurityEmailRequest,
      SendSecurityEmailResponse
    >;

    await controller.sendSecurityEmail(validRequest, new Metadata(), call);

    expect(send).toHaveBeenCalledWith(validRequest, Infinity);
  });

  it('rejects a non-v4 UUID before invoking email delivery', async () => {
    const send = jest.fn();
    const controller = createController(send);
    const request = {
      ...validRequest,
      requestId: '0198f687-15d8-7f5e-bd79-62f8f4d51e07',
    };

    await expect(
      controller.sendSecurityEmail(request, new Metadata(), createCall()),
    ).rejects.toMatchObject({
      error: {
        code: grpcStatus.INVALID_ARGUMENT,
        message: 'Invalid security email command',
      },
    });
    expect(send).not.toHaveBeenCalled();
  });
});

function createController(send: jest.Mock): SecurityEmailController {
  return new SecurityEmailController({
    send,
  } as unknown as SecurityEmailService);
}

function createCall(): ServerUnaryCall<
  SendSecurityEmailRequest,
  SendSecurityEmailResponse
> {
  return {
    getDeadline: () => new Date(Date.now() + 1_000),
  } as ServerUnaryCall<SendSecurityEmailRequest, SendSecurityEmailResponse>;
}
