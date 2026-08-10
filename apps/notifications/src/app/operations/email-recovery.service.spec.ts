import {
  EmailDestinationStatus,
  EmailRecoveryAction,
} from '../../generated/prisma/client';
import {
  EmailRecoveryOperationConflictError,
  EmailRecoveryService,
  EmailRecoveryStateError,
} from './email-recovery.service';

const operationId = '0198f687-15d8-4f5e-bd79-62f8f4d51e07';
const currentDestination = {
  id: '0198f687-15d8-7f5e-bd79-62f8f4d51e07',
  status: EmailDestinationStatus.SUPPRESSED,
  suppressionRevision: 2,
};
const previousDestination = {
  id: '0198f687-15d8-7f5e-bd79-62f8f4d51e08',
  status: EmailDestinationStatus.SUPPRESSED,
  suppressionRevision: 1,
};
const evidence = {
  operationId,
  expectedSuppressionRevision: 2,
  actorId: 'support-operator',
  reasonCode: 'OWNERSHIP_REVERIFIED',
  evidenceReference: 'ticket-123',
};

describe('EmailRecoveryService', () => {
  const transaction = {
    $executeRaw: jest.fn(),
    emailDestination: {
      findMany: jest.fn(),
      updateMany: jest.fn(),
    },
    emailRecoveryAudit: {
      findMany: jest.fn(),
      createMany: jest.fn(),
    },
  };
  const prisma = {
    emailDestination: {
      findMany: jest.fn(),
    },
    $transaction: jest.fn((callback) => callback(transaction)),
  };
  const recipientHashService = {
    createLookupHashes: jest.fn(() => [
      { value: 'a'.repeat(64), keyVersion: 2 },
      { value: 'b'.repeat(64), keyVersion: 1 },
    ]),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    transaction.$executeRaw.mockResolvedValue(0);
    transaction.emailDestination.findMany.mockResolvedValue([
      currentDestination,
      previousDestination,
    ]);
    prisma.emailDestination.findMany.mockResolvedValue([
      currentDestination,
      previousDestination,
    ]);
    transaction.emailDestination.updateMany.mockResolvedValue({ count: 2 });
    transaction.emailRecoveryAudit.findMany.mockResolvedValue([]);
    transaction.emailRecoveryAudit.createMany.mockResolvedValue({ count: 2 });
  });

  function createService() {
    return new EmailRecoveryService(
      prisma as never,
      recipientHashService as never,
    );
  }

  it('inspects recovery state without returning recipient data', async () => {
    const result = await createService().inspectRecovery('User@Example.com');

    expect(prisma.emailDestination.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { recipientHash: 'a'.repeat(64), recipientHashKeyVersion: 2 },
          { recipientHash: 'b'.repeat(64), recipientHashKeyVersion: 1 },
        ],
      },
      select: { status: true, suppressionRevision: true },
    });
    expect(result).toEqual({
      status: EmailDestinationStatus.SUPPRESSED,
      maximumSuppressionRevision: 2,
      aliasCount: 2,
    });
    expect(Object.keys(result)).toEqual([
      'status',
      'maximumSuppressionRevision',
      'aliasCount',
    ]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('reports mixed alias state instead of choosing a misleading status', async () => {
    prisma.emailDestination.findMany.mockResolvedValue([
      currentDestination,
      { ...previousDestination, status: EmailDestinationStatus.ACTIVE },
    ]);

    await expect(
      createService().inspectRecovery('user@example.com'),
    ).resolves.toEqual({
      status: 'MIXED',
      maximumSuppressionRevision: 2,
      aliasCount: 2,
    });
  });

  it('rejects inspection when the destination does not exist', async () => {
    prisma.emailDestination.findMany.mockResolvedValue([]);

    await expect(
      createService().inspectRecovery('user@example.com'),
    ).rejects.toBeInstanceOf(EmailRecoveryStateError);
  });

  it('moves every HMAC row to recovery pending using per-row CAS', async () => {
    await createService().requestRecovery('User@Example.com', evidence);

    expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
    expect(transaction.emailDestination.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { recipientHash: 'a'.repeat(64), recipientHashKeyVersion: 2 },
          { recipientHash: 'b'.repeat(64), recipientHashKeyVersion: 1 },
        ],
      },
    });
    expect(transaction.emailDestination.updateMany).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            id: currentDestination.id,
            status: EmailDestinationStatus.SUPPRESSED,
            suppressionRevision: 2,
          },
          {
            id: previousDestination.id,
            status: EmailDestinationStatus.SUPPRESSED,
            suppressionRevision: 1,
          },
        ],
      },
      data: { status: EmailDestinationStatus.RECOVERY_PENDING },
    });
    expect(transaction.emailRecoveryAudit.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          destinationId: currentDestination.id,
          operationId,
          action: EmailRecoveryAction.REQUESTED,
          suppressionRevision: 2,
        }),
        expect.objectContaining({
          destinationId: previousDestination.id,
          operationId,
          action: EmailRecoveryAction.REQUESTED,
          suppressionRevision: 1,
        }),
      ],
    });
    expect(
      transaction.emailRecoveryAudit.createMany.mock.calls[0][0].data[0],
    ).not.toHaveProperty('recipient');
  });

  it('accepts an exact retry after commit without changing state again', async () => {
    transaction.emailDestination.findMany.mockResolvedValue([
      {
        ...currentDestination,
        status: EmailDestinationStatus.RECOVERY_PENDING,
      },
      {
        ...previousDestination,
        status: EmailDestinationStatus.RECOVERY_PENDING,
      },
    ]);
    transaction.emailRecoveryAudit.findMany.mockResolvedValue([
      recoveryAudit(currentDestination),
      recoveryAudit(previousDestination),
    ]);

    await createService().requestRecovery('user@example.com', evidence);

    expect(transaction.emailDestination.updateMany).not.toHaveBeenCalled();
    expect(transaction.emailRecoveryAudit.createMany).not.toHaveBeenCalled();
  });

  it('accepts an exact retry after a new HMAC alias is added', async () => {
    transaction.emailDestination.findMany.mockResolvedValue([
      {
        ...currentDestination,
        status: EmailDestinationStatus.ACTIVE,
      },
      {
        ...previousDestination,
        status: EmailDestinationStatus.ACTIVE,
      },
    ]);
    transaction.emailRecoveryAudit.findMany.mockResolvedValue([
      recoveryAudit(currentDestination),
    ]);

    await createService().requestRecovery('user@example.com', evidence);

    expect(transaction.emailDestination.updateMany).not.toHaveBeenCalled();
    expect(transaction.emailRecoveryAudit.createMany).not.toHaveBeenCalled();
  });

  it('accepts an exact retry after later feedback changes mutable state', async () => {
    transaction.emailDestination.findMany.mockResolvedValue([
      {
        ...currentDestination,
        status: EmailDestinationStatus.SUPPRESSED,
        suppressionRevision: 3,
      },
      {
        ...previousDestination,
        status: EmailDestinationStatus.SUPPRESSED,
        suppressionRevision: 2,
      },
    ]);
    transaction.emailRecoveryAudit.findMany.mockResolvedValue([
      recoveryAudit(currentDestination),
      recoveryAudit(previousDestination),
    ]);

    await createService().requestRecovery('user@example.com', evidence);

    expect(transaction.emailDestination.updateMany).not.toHaveBeenCalled();
    expect(transaction.emailRecoveryAudit.createMany).not.toHaveBeenCalled();
  });

  it('rejects reuse of an operation ID for different evidence', async () => {
    transaction.emailRecoveryAudit.findMany.mockResolvedValue([
      recoveryAudit(currentDestination),
      recoveryAudit(previousDestination),
    ]);

    await expect(
      createService().requestRecovery('user@example.com', {
        ...evidence,
        reasonCode: 'DIFFERENT_REASON',
      }),
    ).rejects.toBeInstanceOf(EmailRecoveryOperationConflictError);
    expect(transaction.emailDestination.updateMany).not.toHaveBeenCalled();
  });

  it('rejects recovery when the reviewed mailbox revision is stale', async () => {
    await expect(
      createService().requestRecovery('user@example.com', {
        ...evidence,
        expectedSuppressionRevision: 1,
      }),
    ).rejects.toBeInstanceOf(EmailRecoveryStateError);
    expect(transaction.emailDestination.updateMany).not.toHaveBeenCalled();
  });

  it('rejects recovery when feedback wins the compare-and-swap race', async () => {
    transaction.emailDestination.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      createService().requestRecovery('user@example.com', evidence),
    ).rejects.toBeInstanceOf(EmailRecoveryStateError);
    expect(transaction.emailRecoveryAudit.createMany).not.toHaveBeenCalled();
  });

  it('reactivates only pending destinations and records the SES request ID', async () => {
    transaction.emailDestination.findMany.mockResolvedValue([
      {
        ...currentDestination,
        status: EmailDestinationStatus.RECOVERY_PENDING,
      },
      {
        ...previousDestination,
        status: EmailDestinationStatus.RECOVERY_PENDING,
      },
    ]);

    await createService().completeRecovery('user@example.com', {
      ...evidence,
      providerRequestId: 'aws-request-id',
    });

    expect(transaction.emailDestination.updateMany).toHaveBeenCalledWith({
      where: {
        OR: [
          {
            id: currentDestination.id,
            status: EmailDestinationStatus.RECOVERY_PENDING,
            suppressionRevision: 2,
          },
          {
            id: previousDestination.id,
            status: EmailDestinationStatus.RECOVERY_PENDING,
            suppressionRevision: 1,
          },
        ],
      },
      data: {
        status: EmailDestinationStatus.ACTIVE,
        reasonCode: null,
        suppressedAt: null,
      },
    });
    expect(transaction.emailRecoveryAudit.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          action: EmailRecoveryAction.COMPLETED,
          providerRequestId: 'aws-request-id',
        }),
      ]),
    });
  });

  it('requires a provider request ID before recovery is completed', async () => {
    await expect(
      createService().completeRecovery('user@example.com', evidence),
    ).rejects.toThrow('provider-request is required for completion');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each([
    [{ ...evidence, actorId: 'operator@example.com' }, 'actor'],
    [{ ...evidence, reasonCode: 'free form reason' }, 'reason'],
    [{ ...evidence, evidenceReference: 'customer@example.com' }, 'evidence'],
    [{ ...evidence, providerRequestId: '   ' }, 'provider-request'],
  ])('rejects non-opaque recovery evidence', async (invalid, field) => {
    await expect(
      createService().requestRecovery('user@example.com', invalid),
    ).rejects.toThrow(field);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

function recoveryAudit(destination: {
  id: string;
  suppressionRevision: number;
}) {
  return {
    id: '0198f687-15d8-4f5e-bd79-62f8f4d51e99',
    destinationId: destination.id,
    operationId,
    action: EmailRecoveryAction.REQUESTED,
    actorId: evidence.actorId,
    reasonCode: evidence.reasonCode,
    evidenceReference: evidence.evidenceReference,
    providerRequestId: null,
    failureCode: null,
    previousStatus: EmailDestinationStatus.SUPPRESSED,
    nextStatus: EmailDestinationStatus.RECOVERY_PENDING,
    suppressionRevision: destination.suppressionRevision,
    createdAt: new Date('2026-08-08T10:00:00.000Z'),
  };
}
