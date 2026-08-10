import { Metadata } from '@grpc/grpc-js';
import {
  NOTIFICATIONS_EMAIL_SERVICE_NAME,
  SecurityEmailPurpose,
  SendSecurityEmailResult,
} from '@pixaeron/notifications-contract';
import { of, throwError } from 'rxjs';

import { NotificationsEmailClient } from './notifications-email.client';

describe('NotificationsEmailClient', () => {
  const grpcService = { sendSecurityEmail: jest.fn() };
  const grpcClient = { getService: jest.fn(() => grpcService) };
  const configService = {
    get: jest.fn((key: string) =>
      key === 'NOTIFICATIONS_GRPC_DEADLINE_MS' ? '2000' : undefined,
    ),
  };
  const request = {
    requestId: '0198f687-15d8-7f5e-bd79-62f8f4d51e07',
    publicSubject: '0198f687-15d8-7f5e-bd79-62f8f4d51e08',
    recipient: 'user@example.com',
    purpose: SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_EMAIL_VERIFICATION,
    token: 'raw-token',
    contentVersion: 1,
  };

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-08-08T12:00:00.000Z'));
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  function createClient(): NotificationsEmailClient {
    const client = new NotificationsEmailClient(
      grpcClient as never,
      configService as never,
    );
    client.onModuleInit();
    return client;
  }

  it('resolves the generated service and applies a fresh per-call deadline', async () => {
    const response = {
      result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_ACCEPTED,
    };
    grpcService.sendSecurityEmail.mockReturnValue(of(response));
    const client = createClient();

    await expect(client.sendSecurityEmail(request)).resolves.toEqual(response);

    expect(grpcClient.getService).toHaveBeenCalledWith(
      NOTIFICATIONS_EMAIL_SERVICE_NAME,
    );
    expect(grpcService.sendSecurityEmail).toHaveBeenCalledWith(
      request,
      expect.any(Metadata),
      { deadline: new Date('2026-08-08T12:00:02.000Z') },
    );
  });

  it('propagates transport failures for the delivery service to classify', async () => {
    grpcService.sendSecurityEmail.mockReturnValue(
      throwError(() => new Error('notifications unavailable')),
    );

    await expect(createClient().sendSecurityEmail(request)).rejects.toThrow(
      'notifications unavailable',
    );
  });
});
