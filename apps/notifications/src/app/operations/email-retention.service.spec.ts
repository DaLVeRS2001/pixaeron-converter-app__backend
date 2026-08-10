import { EmailDestinationStatus } from '../../generated/prisma/client';
import { EmailRetentionService } from './email-retention.service';

describe('EmailRetentionService', () => {
  const transaction = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(),
    emailDeliveryEvent: { deleteMany: jest.fn() },
    emailRecoveryAudit: { deleteMany: jest.fn() },
    emailDelivery: { deleteMany: jest.fn() },
    emailDestination: { deleteMany: jest.fn() },
  };
  const prisma = {
    $transaction: jest.fn((callback) => callback(transaction)),
  };
  const config = {
    getOrThrow: jest.fn().mockReturnValue('2'),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    transaction.$queryRaw.mockResolvedValue([{ acquired: true }]);
    transaction.$executeRaw.mockResolvedValue(1);
    transaction.emailDeliveryEvent.deleteMany.mockResolvedValue({ count: 2 });
    transaction.emailRecoveryAudit.deleteMany.mockResolvedValue({ count: 1 });
    transaction.emailDelivery.deleteMany.mockResolvedValue({ count: 3 });
    transaction.emailDestination.deleteMany.mockResolvedValue({ count: 4 });
  });

  it('deletes retained history and retired non-blocking aliases while holding the lock', async () => {
    await createService().cleanupExpiredHistory();

    expect(transaction.$queryRaw).toHaveBeenCalledTimes(1);
    expect(transaction.emailDeliveryEvent.deleteMany).toHaveBeenCalledWith({
      where: { receivedAt: { lt: expect.any(Date) } },
    });
    expect(transaction.emailRecoveryAudit.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expect.any(Date) } },
    });
    expect(transaction.emailDelivery.deleteMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: expect.any(Date) },
        events: { none: {} },
      },
    });
    expect(transaction.emailDestination.deleteMany).toHaveBeenCalledWith({
      where: {
        recipientHashKeyVersion: { not: 2 },
        status: {
          in: [
            EmailDestinationStatus.ACTIVE,
            EmailDestinationStatus.TEMPORARY_FAILURE,
          ],
        },
        recoveryAudits: { none: {} },
      },
    });
  });

  it('requires an equivalent active-key record before deleting a blocking alias', async () => {
    await createService().cleanupExpiredHistory();

    const [query, excludedActiveVersion, requiredActiveVersion] = transaction
      .$executeRaw.mock.calls[0] as [TemplateStringsArray, number, number];
    const sql = query.join(' value ');

    expect([excludedActiveVersion, requiredActiveVersion]).toEqual([2, 2]);
    expect(sql).toContain(
      '"active_destination"."last_event_id" = "old_destination"."last_event_id"',
    );
    expect(sql).toContain(
      '"active_destination"."last_event_fingerprint" IS NOT DISTINCT FROM "old_destination"."last_event_fingerprint"',
    );
    expect(sql).toContain(
      '"active_destination"."suppression_revision" = "old_destination"."suppression_revision"',
    );
    expect(sql).toContain(
      '"recovery_audit"."destination_id" = "old_destination"."id"',
    );
  });

  it('does nothing when another replica owns the cleanup lock', async () => {
    transaction.$queryRaw.mockResolvedValue([{ acquired: false }]);

    await createService().cleanupExpiredHistory();

    expect(transaction.emailDeliveryEvent.deleteMany).not.toHaveBeenCalled();
    expect(transaction.emailRecoveryAudit.deleteMany).not.toHaveBeenCalled();
    expect(transaction.emailDelivery.deleteMany).not.toHaveBeenCalled();
    expect(transaction.emailDestination.deleteMany).not.toHaveBeenCalled();
    expect(transaction.$executeRaw).not.toHaveBeenCalled();
  });

  function createService(): EmailRetentionService {
    return new EmailRetentionService(prisma as never, config as never);
  }
});
