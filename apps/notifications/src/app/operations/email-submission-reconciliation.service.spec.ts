import { Logger } from '@nestjs/common';

import {
  EmailCommandResult,
  EmailDeliveryStatus,
} from '../../generated/prisma/client';
import { EmailSubmissionReconciliationService } from './email-submission-reconciliation.service';

describe('EmailSubmissionReconciliationService', () => {
  const prisma = {
    emailDelivery: { updateMany: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.emailDelivery.updateMany.mockResolvedValue({ count: 1 });
  });

  afterEach(() => jest.restoreAllMocks());

  it('finalizes an expired unobserved claim as submission unknown', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    await new EmailSubmissionReconciliationService(
      prisma as never,
    ).expireStaleClaims();

    const update = prisma.emailDelivery.updateMany.mock.calls[0][0];
    expect(update).toEqual({
      where: {
        status: EmailDeliveryStatus.PENDING,
        callerResult: null,
        leaseExpiresAt: { lte: expect.any(Date) },
      },
      data: {
        status: EmailDeliveryStatus.SUBMISSION_UNKNOWN,
        callerResult: EmailCommandResult.SUBMISSION_UNKNOWN,
        callerResultCode: 'SUBMISSION_LEASE_EXPIRED',
        failureCode: 'SUBMISSION_LEASE_EXPIRED',
        leaseExpiresAt: null,
        finalizedAt: expect.any(Date),
      },
    });
    expect(update.where.leaseExpiresAt.lte).toBe(update.data.finalizedAt);
  });

  it('stays quiet when no claim is expired', async () => {
    prisma.emailDelivery.updateMany.mockResolvedValue({ count: 0 });
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);

    await new EmailSubmissionReconciliationService(
      prisma as never,
    ).expireStaleClaims();

    expect(warn).not.toHaveBeenCalled();
  });
});
