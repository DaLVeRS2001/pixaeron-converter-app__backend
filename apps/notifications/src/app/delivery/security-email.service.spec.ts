import {
  SecurityEmailPurpose,
  SendSecurityEmailResult,
} from '@pixaeron/notifications-contract';
import { createHash } from 'node:crypto';

import {
  EmailCommandResult,
  EmailDeliveryStatus,
  EmailDestinationStatus,
  EmailPurpose,
} from '../../generated/prisma/client';
import {
  EmailCommandConflictError,
  SecurityEmailService,
} from './security-email.service';

const request = {
  requestId: '0198f687-15d8-7f5e-bd79-62f8f4d51e07',
  publicSubject: '0198f687-15d8-7f5e-bd79-62f8f4d51e08',
  recipient: 'User@Example.com',
  purpose: SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_EMAIL_VERIFICATION,
  token: 'security-token',
  contentVersion: 1,
};

const activeHash = { value: 'a'.repeat(64), keyVersion: 2 };
const previousHash = { value: 'b'.repeat(64), keyVersion: 1 };
const sesRequestTimeoutMs = 30_000;
const tokenFingerprint = createHash('sha256')
  .update(request.token)
  .digest('hex');

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    id: '0198f687-15d8-7f5e-bd79-62f8f4d51e09',
    requestId: request.requestId,
    publicSubject: request.publicSubject,
    recipientHash: activeHash.value,
    recipientHashKeyVersion: activeHash.keyVersion,
    purpose: EmailPurpose.EMAIL_VERIFICATION,
    contentVersion: 1,
    tokenFingerprint,
    status: EmailDeliveryStatus.PENDING,
    callerResult: null,
    callerResultCode: null,
    providerMessageId: null,
    attemptCount: 0,
    leaseExpiresAt: new Date(Date.now() + sesRequestTimeoutMs + 1_000),
    failureCode: null,
    submittedAt: null,
    finalizedAt: null,
    lastEventAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('SecurityEmailService', () => {
  const transaction = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    emailDelivery: {
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
      findUniqueOrThrow: jest.fn(),
    },
    emailDestination: { findFirst: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((callback) => callback(transaction)),
    emailDelivery: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const recipientHashService = {
    create: jest.fn(() => activeHash),
    createLookupHashes: jest.fn(() => [activeHash, previousHash]),
  };
  const sesEmailService = { submit: jest.fn() };
  const configService = {
    getOrThrow: jest.fn((key: string) => {
      if (key === 'FRONTEND_URL') return 'https://pixaeron.com';
      if (key === 'SES_REQUEST_TIMEOUT_MS') {
        return String(sesRequestTimeoutMs);
      }
      throw new Error(`Unexpected config key: ${key}`);
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    transaction.emailDelivery.findUnique.mockResolvedValue(null);
    transaction.emailDestination.findFirst.mockResolvedValue(null);
    transaction.emailDelivery.create.mockResolvedValue(delivery());
    transaction.emailDelivery.updateMany.mockResolvedValue({ count: 1 });
    transaction.emailDelivery.findUniqueOrThrow.mockResolvedValue(
      delivery({
        status: EmailDeliveryStatus.ACCEPTED,
        callerResult: EmailCommandResult.ACCEPTED,
        providerMessageId: 'ses-message-id',
        attemptCount: 1,
        leaseExpiresAt: null,
        submittedAt: new Date(),
        finalizedAt: new Date(),
      }),
    );
    prisma.emailDelivery.updateMany.mockResolvedValue({ count: 1 });
    prisma.emailDelivery.findUnique.mockResolvedValue(null);
    sesEmailService.submit.mockResolvedValue({
      status: 'ACCEPTED',
      messageId: 'ses-message-id',
    });
  });

  function createService() {
    return new SecurityEmailService(
      prisma as never,
      recipientHashService as never,
      sesEmailService as never,
      configService as never,
    );
  }

  it('commits the delivery claim before making one SES wire attempt', async () => {
    const response = await createService().send(request, Date.now() + 2_000);

    expect(response).toEqual({
      result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_ACCEPTED,
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(sesEmailService.submit).toHaveBeenCalledTimes(1);
    expect(transaction.emailDelivery.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tokenFingerprint }),
    });
    expect(sesEmailService.submit).toHaveBeenCalledWith(
      'user@example.com',
      request.requestId,
      expect.objectContaining({
        subject: expect.any(String),
        html: expect.stringContaining('security-token'),
      }),
    );
    expect(prisma.$transaction.mock.invocationCallOrder[0]).toBeLessThan(
      sesEmailService.submit.mock.invocationCallOrder[0],
    );
  });

  it('locks every recipient alias before checking suppression', async () => {
    await createService().send(request, Date.now() + 2_000);

    const lockKeys = transaction.$executeRaw.mock.calls.map(
      ([, lockKey]) => lockKey,
    );
    expect(lockKeys).toEqual([
      `${previousHash.keyVersion}:${previousHash.value}`,
      `${activeHash.keyVersion}:${activeHash.value}`,
    ]);
    expect(
      transaction.$executeRaw.mock.invocationCallOrder.at(-1),
    ).toBeLessThan(
      transaction.emailDestination.findFirst.mock.invocationCallOrder[0],
    );
  });

  it('submits with the SES request timeout, not the caller deadline budget', async () => {
    const now = new Date('2026-08-08T10:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);

    try {
      await createService().send(request, now.getTime() + 750);

      // The SES call owns its own timeout; the caller's remaining budget is
      // no longer threaded into the provider request.
      expect(sesEmailService.submit).toHaveBeenCalledWith(
        'user@example.com',
        request.requestId,
        expect.any(Object),
      );
      expect(sesEmailService.submit.mock.calls[0]).toHaveLength(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it('still submits when the caller deadline has already passed', async () => {
    const now = new Date('2026-08-08T10:00:00.000Z');
    jest.useFakeTimers().setSystemTime(now);

    try {
      // A slow claim can push submit() past the caller deadline. The email is
      // still worth sending, so the delivery must not be dropped as terminal.
      await expect(
        createService().send(request, now.getTime()),
      ).resolves.toEqual({
        result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_ACCEPTED,
      });

      expect(sesEmailService.submit).toHaveBeenCalledTimes(1);
      expect(prisma.emailDelivery.updateMany).toHaveBeenCalledWith({
        where: {
          id: expect.any(String),
          status: EmailDeliveryStatus.PENDING,
          attemptCount: 0,
        },
        data: { attemptCount: 1 },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps the delivery lease beyond the maximum SES timeout', async () => {
    const now = new Date('2026-08-08T10:00:00.000Z');
    const expectedLeaseExpiresAt = new Date(
      now.getTime() + sesRequestTimeoutMs + 1_000,
    );
    jest.useFakeTimers().setSystemTime(now);

    try {
      await createService().send(request, now.getTime() + 2_000);

      expect(transaction.emailDelivery.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          leaseExpiresAt: expectedLeaseExpiresAt,
        }),
      });
      expect(expectedLeaseExpiresAt.getTime()).toBeGreaterThan(
        now.getTime() + sesRequestTimeoutMs,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it.each([
    EmailDestinationStatus.SUPPRESSED,
    EmailDestinationStatus.RECOVERY_PENDING,
  ])('blocks a %s mailbox without calling SES', async (status) => {
    transaction.emailDestination.findFirst.mockResolvedValue({
      id: 'blocked',
      status,
    });
    transaction.emailDelivery.create.mockResolvedValue(
      delivery({
        status: EmailDeliveryStatus.SUPPRESSED,
        callerResult: EmailCommandResult.SUPPRESSED,
        callerResultCode: 'DESTINATION_SUPPRESSED',
        failureCode: 'DESTINATION_SUPPRESSED',
      }),
    );

    await expect(
      createService().send(request, Date.now() + 2_000),
    ).resolves.toEqual({
      result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_SUPPRESSED,
      code: 'DESTINATION_SUPPRESSED',
    });
    expect(transaction.emailDestination.findFirst).toHaveBeenCalledWith({
      where: {
        status: {
          in: [
            EmailDestinationStatus.SUPPRESSED,
            EmailDestinationStatus.RECOVERY_PENDING,
          ],
        },
        OR: [
          {
            recipientHash: activeHash.value,
            recipientHashKeyVersion: activeHash.keyVersion,
          },
          {
            recipientHash: previousHash.value,
            recipientHashKeyVersion: previousHash.keyVersion,
          },
        ],
      },
      select: { id: true },
    });
    expect(sesEmailService.submit).not.toHaveBeenCalled();
  });

  it('does not persist a transient in-progress duplicate response', async () => {
    transaction.emailDelivery.findUnique.mockResolvedValue(
      delivery({ leaseExpiresAt: new Date(Date.now() + 10_000) }),
    );

    await expect(createService().send(request, Date.now())).resolves.toEqual({
      result:
        SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_SUBMISSION_UNKNOWN,
      code: 'COMMAND_IN_PROGRESS',
    });
    expect(prisma.emailDelivery.updateMany).not.toHaveBeenCalled();
    expect(transaction.emailDelivery.updateMany).not.toHaveBeenCalled();
    expect(sesEmailService.submit).not.toHaveBeenCalled();
  });

  it('returns a finalized duplicate without sending again', async () => {
    transaction.emailDelivery.findUnique.mockResolvedValue(
      delivery({
        callerResult: EmailCommandResult.ACCEPTED,
        status: EmailDeliveryStatus.ACCEPTED,
      }),
    );

    await expect(
      createService().send(request, Date.now() + 2_000),
    ).resolves.toEqual({
      result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_ACCEPTED,
    });
    expect(sesEmailService.submit).not.toHaveBeenCalled();
  });

  it('recognizes an idempotent request created with the previous HMAC key', async () => {
    transaction.emailDelivery.findUnique.mockResolvedValue(
      delivery({
        recipientHash: previousHash.value,
        recipientHashKeyVersion: previousHash.keyVersion,
        callerResult: EmailCommandResult.ACCEPTED,
        status: EmailDeliveryStatus.ACCEPTED,
      }),
    );

    await expect(
      createService().send(request, Date.now() + 2_000),
    ).resolves.toEqual({
      result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_ACCEPTED,
    });
  });

  it('rejects request-ID reuse for a different command', async () => {
    transaction.emailDelivery.findUnique.mockResolvedValue(
      delivery({ publicSubject: '0198f687-15d8-7f5e-bd79-62f8f4d51e10' }),
    );

    await expect(
      createService().send(request, Date.now() + 2_000),
    ).rejects.toBeInstanceOf(EmailCommandConflictError);
    expect(sesEmailService.submit).not.toHaveBeenCalled();
  });

  it('rejects request-ID reuse with a different security token', async () => {
    transaction.emailDelivery.findUnique.mockResolvedValue(
      delivery({ tokenFingerprint: 'f'.repeat(64) }),
    );

    await expect(
      createService().send(request, Date.now() + 2_000),
    ).rejects.toBeInstanceOf(EmailCommandConflictError);
    expect(sesEmailService.submit).not.toHaveBeenCalled();
  });

  it('records a template rendering failure without calling SES', async () => {
    transaction.emailDelivery.findUniqueOrThrow.mockResolvedValue(
      delivery({
        status: EmailDeliveryStatus.FAILED,
        callerResult: EmailCommandResult.FAILED,
        callerResultCode: 'EMAIL_RENDER_FAILED',
        failureCode: 'EMAIL_RENDER_FAILED',
        attemptCount: 1,
        leaseExpiresAt: null,
        finalizedAt: new Date(),
      }),
    );

    const unsupportedContentVersion = {
      ...request,
      contentVersion: 999,
    };

    await expect(
      createService().send(unsupportedContentVersion, Date.now() + 2_000),
    ).resolves.toEqual({
      result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_FAILED,
      code: 'EMAIL_RENDER_FAILED',
    });
    expect(sesEmailService.submit).not.toHaveBeenCalled();
    expect(transaction.emailDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        id: expect.any(String),
        status: {
          in: [
            EmailDeliveryStatus.PENDING,
            EmailDeliveryStatus.SUBMISSION_UNKNOWN,
          ],
        },
      },
      data: expect.objectContaining({
        status: EmailDeliveryStatus.FAILED,
        failureCode: 'EMAIL_RENDER_FAILED',
      }),
    });
    expect(transaction.emailDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: expect.any(String), callerResult: null },
      data: expect.objectContaining({
        callerResult: EmailCommandResult.FAILED,
        callerResultCode: 'EMAIL_RENDER_FAILED',
      }),
    });
  });

  it('records an unexpected SES error as an ambiguous submission', async () => {
    sesEmailService.submit.mockRejectedValue(
      new Error('unexpected SES adapter failure'),
    );
    transaction.emailDelivery.findUniqueOrThrow.mockResolvedValue(
      delivery({
        status: EmailDeliveryStatus.SUBMISSION_UNKNOWN,
        callerResult: EmailCommandResult.SUBMISSION_UNKNOWN,
        callerResultCode: 'SES_SUBMISSION_UNKNOWN',
        failureCode: 'SES_SUBMISSION_UNKNOWN',
        attemptCount: 1,
        leaseExpiresAt: null,
        finalizedAt: new Date(),
      }),
    );

    await expect(
      createService().send(request, Date.now() + 2_000),
    ).resolves.toEqual({
      result:
        SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_SUBMISSION_UNKNOWN,
      code: 'SES_SUBMISSION_UNKNOWN',
    });
    expect(sesEmailService.submit).toHaveBeenCalledTimes(1);
    expect(transaction.emailDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        id: expect.any(String),
        status: { in: [EmailDeliveryStatus.PENDING] },
      },
      data: expect.objectContaining({
        status: EmailDeliveryStatus.SUBMISSION_UNKNOWN,
        failureCode: 'SES_SUBMISSION_UNKNOWN',
      }),
    });
    expect(transaction.emailDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: expect.any(String), callerResult: null },
      data: expect.objectContaining({
        callerResult: EmailCommandResult.SUBMISSION_UNKNOWN,
        callerResultCode: 'SES_SUBMISSION_UNKNOWN',
      }),
    });
  });

  it('does not retry an ambiguous SES submission', async () => {
    sesEmailService.submit.mockResolvedValue({
      status: 'SUBMISSION_UNKNOWN',
      code: 'SES_SUBMISSION_UNKNOWN',
    });
    transaction.emailDelivery.findUniqueOrThrow.mockResolvedValue(
      delivery({
        status: EmailDeliveryStatus.SUBMISSION_UNKNOWN,
        callerResult: EmailCommandResult.SUBMISSION_UNKNOWN,
        callerResultCode: 'SES_SUBMISSION_UNKNOWN',
        attemptCount: 1,
        leaseExpiresAt: null,
        finalizedAt: new Date(),
      }),
    );

    await expect(
      createService().send(request, Date.now() + 2_000),
    ).resolves.toEqual({
      result:
        SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_SUBMISSION_UNKNOWN,
      code: 'SES_SUBMISSION_UNKNOWN',
    });
    expect(sesEmailService.submit).toHaveBeenCalledTimes(1);
    expect(transaction.emailDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        id: expect.any(String),
        status: { in: [EmailDeliveryStatus.PENDING] },
      },
      data: expect.objectContaining({
        status: EmailDeliveryStatus.SUBMISSION_UNKNOWN,
        failureCode: 'SES_SUBMISSION_UNKNOWN',
      }),
    });
    expect(transaction.emailDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: expect.any(String), callerResult: null },
      data: expect.objectContaining({
        callerResult: EmailCommandResult.SUBMISSION_UNKNOWN,
        callerResultCode: 'SES_SUBMISSION_UNKNOWN',
      }),
    });
  });

  it.each([
    {
      callerResult: EmailCommandResult.ACCEPTED,
      callerResultCode: null,
      expected: {
        result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_ACCEPTED,
      },
    },
    {
      callerResult: EmailCommandResult.SUBMISSION_UNKNOWN,
      callerResultCode: 'SES_SUBMISSION_UNKNOWN',
      expected: {
        result:
          SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_SUBMISSION_UNKNOWN,
        code: 'SES_SUBMISSION_UNKNOWN',
      },
    },
  ])(
    'returns the immutable caller result instead of mutable provider failure state',
    async ({ callerResult, callerResultCode, expected }) => {
      transaction.emailDelivery.findUnique.mockResolvedValue(
        delivery({
          callerResult,
          callerResultCode,
          failureCode: 'COMPLAINT_ABUSE',
        }),
      );

      await expect(
        createService().send(request, Date.now() + 2_000),
      ).resolves.toEqual(expected);
    },
  );

  it('keeps an expired caller result while recording a late accepted SES response', async () => {
    transaction.emailDelivery.findUniqueOrThrow.mockResolvedValue(
      delivery({
        status: EmailDeliveryStatus.ACCEPTED,
        callerResult: EmailCommandResult.SUBMISSION_UNKNOWN,
        callerResultCode: 'SUBMISSION_LEASE_EXPIRED',
        providerMessageId: 'ses-message-id',
        attemptCount: 1,
        leaseExpiresAt: null,
        finalizedAt: new Date(),
      }),
    );

    await expect(
      createService().send(request, Date.now() + 2_000),
    ).resolves.toEqual({
      result:
        SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_SUBMISSION_UNKNOWN,
      code: 'SUBMISSION_LEASE_EXPIRED',
    });
    expect(transaction.emailDelivery.updateMany).toHaveBeenCalledWith({
      where: {
        id: expect.any(String),
        providerMessageId: null,
      },
      data: { providerMessageId: 'ses-message-id' },
    });
  });

  it('returns accepted when feedback finalizes the caller during an SES timeout', async () => {
    sesEmailService.submit.mockResolvedValue({
      status: 'SUBMISSION_UNKNOWN',
      code: 'SES_SUBMISSION_UNKNOWN',
    });
    transaction.emailDelivery.findUniqueOrThrow.mockResolvedValue(
      delivery({
        status: EmailDeliveryStatus.DELIVERED,
        callerResult: EmailCommandResult.ACCEPTED,
        callerResultCode: null,
        providerMessageId: 'ses-message-id',
        attemptCount: 1,
        leaseExpiresAt: null,
        finalizedAt: new Date(),
      }),
    );

    await expect(
      createService().send(request, Date.now() + 2_000),
    ).resolves.toEqual({
      result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_ACCEPTED,
    });
  });

  it('re-reads a concurrent finalized result when persistence fails', async () => {
    prisma.$transaction
      .mockImplementationOnce((claimCallback) => claimCallback(transaction))
      .mockRejectedValueOnce(new Error('database write failed'));
    prisma.emailDelivery.findUnique.mockResolvedValue(
      delivery({
        status: EmailDeliveryStatus.ACCEPTED,
        callerResult: EmailCommandResult.ACCEPTED,
        callerResultCode: null,
      }),
    );

    await expect(
      createService().send(request, Date.now() + 2_000),
    ).resolves.toEqual({
      result: SendSecurityEmailResult.SEND_SECURITY_EMAIL_RESULT_ACCEPTED,
    });
  });
});
