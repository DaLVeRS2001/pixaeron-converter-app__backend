import { ConfigService } from '@nestjs/config';

import {
  EmailCommandResult,
  EmailDeliveryEventType,
  EmailDeliveryStatus,
  EmailDestinationStatus,
  EmailPurpose,
  type EmailDelivery,
  type EmailDeliveryEvent,
  type EmailDestination,
  type Prisma,
} from '../../generated/prisma/client';
import type { RecipientHashService } from '../delivery/recipient-hash.service';
import type { PrismaService } from '../prisma/prisma.service';
import {
  ConflictingSesFeedbackError,
  SesFeedbackProcessor,
} from './ses-feedback.processor';

const source = {
  SES_FEEDBACK_TOPIC_ARN:
    'arn:aws:sns:eu-central-1:123456789012:pixaeron-feedback',
  SES_EXPECTED_ACCOUNT_ID: '123456789012',
  SES_EXPECTED_SOURCE_ARN:
    'arn:aws:ses:eu-central-1:123456789012:identity/pixaeron.com',
  SES_CONFIGURATION_SET: 'pixaeron-transactional',
};

const requestId = '123e4567-e89b-42d3-a456-426614174000';
const providerTimestamp = '2026-08-08T10:01:00.000Z';
const recipientHashes = [
  { value: 'current-recipient-hash', keyVersion: 2 },
  { value: 'previous-recipient-hash', keyVersion: 1 },
];

const baseDelivery: EmailDelivery = {
  id: '223e4567-e89b-42d3-a456-426614174000',
  requestId,
  publicSubject: '323e4567-e89b-42d3-a456-426614174000',
  recipientHash: recipientHashes[0].value,
  recipientHashKeyVersion: recipientHashes[0].keyVersion,
  purpose: EmailPurpose.EMAIL_VERIFICATION,
  contentVersion: 1,
  tokenFingerprint: 'c'.repeat(64),
  status: EmailDeliveryStatus.PENDING,
  callerResult: null,
  callerResultCode: null,
  providerMessageId: 'ses-message-id',
  attemptCount: 1,
  leaseExpiresAt: null,
  failureCode: null,
  submittedAt: null,
  finalizedAt: null,
  lastEventAt: null,
  lastEventRank: null,
  lastEventFingerprint: null,
  createdAt: new Date('2026-08-08T10:00:00.000Z'),
  updatedAt: new Date('2026-08-08T10:00:00.000Z'),
};

describe('SesFeedbackProcessor', () => {
  it('reconciles feedback by request ID without changing a recorded unknown result', async () => {
    const harness = createHarness({
      delivery: {
        ...baseDelivery,
        status: EmailDeliveryStatus.SUBMISSION_UNKNOWN,
        callerResult: EmailCommandResult.SUBMISSION_UNKNOWN,
        callerResultCode: 'SES_SUBMISSION_UNKNOWN',
        providerMessageId: null,
      },
      findByMessageId: null,
    });

    await expect(
      harness.processor.process(
        createFeedbackBody({
          eventType: 'Delivery',
          delivery: { timestamp: providerTimestamp },
        }),
      ),
    ).resolves.toBe('PROCESSED');

    expect(harness.transaction.emailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: baseDelivery.id,
          OR: [
            { providerMessageId: null },
            { providerMessageId: 'ses-message-id' },
          ],
        }),
        data: { providerMessageId: 'ses-message-id' },
      }),
    );
    expect(harness.transaction.emailDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: baseDelivery.id, submittedAt: null },
      data: { submittedAt: new Date('2026-08-08T10:00:00.000Z') },
    });
    expect(harness.transaction.emailDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: baseDelivery.id, callerResult: null },
      data: {
        callerResult: EmailCommandResult.ACCEPTED,
        callerResultCode: null,
        leaseExpiresAt: null,
        finalizedAt: expect.any(Date),
      },
    });
    expect(harness.transaction.emailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: EmailDeliveryStatus.DELIVERED,
          lastEventAt: new Date(providerTimestamp),
          lastEventRank: 30,
        }),
      }),
    );
  });
  it('finalizes a null caller result when feedback confirms an ambiguous submission', async () => {
    const harness = createHarness({
      delivery: {
        ...baseDelivery,
        callerResult: null,
        failureCode: 'SUBMISSION_LEASE_EXPIRED',
        leaseExpiresAt: new Date('2026-08-08T10:02:00.000Z'),
      },
    });

    await harness.processor.process(
      createFeedbackBody({ eventType: 'Send', send: {} }),
    );

    expect(harness.transaction.emailDelivery.updateMany).toHaveBeenCalledWith({
      where: { id: baseDelivery.id, callerResult: null },
      data: {
        callerResult: EmailCommandResult.ACCEPTED,
        callerResultCode: null,
        leaseExpiresAt: null,
        finalizedAt: expect.any(Date),
      },
    });
    expect(harness.transaction.emailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: EmailDeliveryStatus.ACCEPTED,
          failureCode: null,
          lastEventAt: new Date('2026-08-08T10:00:00.000Z'),
          lastEventRank: 10,
          lastEventFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
  });
  it.each([
    {
      name: 'Delivery',
      status: EmailDeliveryStatus.DELIVERED,
      failureCode: null,
    },
    {
      name: 'Complaint',
      status: EmailDeliveryStatus.COMPLAINED,
      failureCode: 'COMPLAINT_ABUSE',
    },
  ])(
    'fills a null caller result after $name without coupling it to provider state',
    async ({ status, failureCode }) => {
      const harness = createHarness({
        delivery: {
          ...baseDelivery,
          status,
          callerResult: null,
          failureCode,
          lastEventAt: new Date(providerTimestamp),
          lastEventRank: 60,
          lastEventFingerprint: 'f'.repeat(64),
        },
      });

      await harness.processor.process(
        createFeedbackBody({ eventType: 'Send', send: {} }),
      );

      expect(harness.transaction.emailDelivery.updateMany).toHaveBeenCalledWith(
        {
          where: {
            id: baseDelivery.id,
            callerResult: null,
          },
          data: {
            callerResult: EmailCommandResult.ACCEPTED,
            callerResultCode: null,
            leaseExpiresAt: null,
            finalizedAt: expect.any(Date),
          },
        },
      );
    },
  );
  it.each([
    {
      name: 'permanent bounce',
      event: {
        eventType: 'Bounce',
        bounce: {
          timestamp: providerTimestamp,
          bounceType: 'Permanent',
          bounceSubType: 'General',
          feedbackId: 'bounce-id',
        },
      },
      deliveryStatus: EmailDeliveryStatus.BOUNCED,
      eventType: EmailDeliveryEventType.BOUNCE,
    },
    {
      name: 'complaint',
      event: {
        eventType: 'Complaint',
        complaint: {
          timestamp: providerTimestamp,
          feedbackId: 'complaint-id',
          complaintFeedbackType: 'abuse',
        },
      },
      deliveryStatus: EmailDeliveryStatus.COMPLAINED,
      eventType: EmailDeliveryEventType.COMPLAINT,
    },
    {
      name: 'provider suppression',
      event: {
        eventType: 'Bounce',
        bounce: {
          timestamp: providerTimestamp,
          bounceType: 'Permanent',
          bounceSubType: 'Suppressed',
          feedbackId: 'suppression-id',
        },
      },
      deliveryStatus: EmailDeliveryStatus.SUPPRESSED,
      eventType: EmailDeliveryEventType.BOUNCE,
    },
  ])(
    'makes $name terminal for every readable recipient hash',
    async ({ event, deliveryStatus, eventType }) => {
      const harness = createHarness();

      await expect(
        harness.processor.process(createFeedbackBody(event)),
      ).resolves.toBe('PROCESSED');

      expect(
        harness.transaction.emailDeliveryEvent.create,
      ).toHaveBeenCalledWith({
        data: expect.objectContaining({
          deliveryId: baseDelivery.id,
          type: eventType,
          providerMessageId: 'ses-message-id',
        }),
      });
      expect(harness.transaction.emailDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: deliveryStatus }),
        }),
      );
      expect(harness.transaction.emailDestination.upsert).toHaveBeenCalledTimes(
        2,
      );
      for (const hash of recipientHashes) {
        expect(
          harness.transaction.emailDestination.upsert,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            create: expect.objectContaining({
              recipientHash: hash.value,
              recipientHashKeyVersion: hash.keyVersion,
              status: EmailDestinationStatus.SUPPRESSED,
            }),
          }),
        );
      }
    },
  );

  it('converges rotated aliases after out-of-order terminal feedback', async () => {
    const authoritativeDestination = {
      reasonCode: 'COMPLAINT_ABUSE',
      lastDeliveryId: '423e4567-e89b-42d3-a456-426614174001',
      lastEventId: '423e4567-e89b-42d3-a456-426614174002',
      lastEventAt: new Date('2026-08-08T11:00:00.000Z'),
      lastEventRank: 60,
      lastEventFingerprint: 'f'.repeat(64),
    };
    const harness = createHarness({
      maximumSuppressionRevision: 3,
      earliestSuppressedAt: new Date('2026-08-08T10:30:00.000Z'),
      authoritativeDestination,
    });

    await harness.processor.process(
      createFeedbackBody({
        eventType: 'Bounce',
        bounce: {
          timestamp: providerTimestamp,
          bounceType: 'Permanent',
          bounceSubType: 'General',
          feedbackId: 'rotation-bounce-id',
        },
      }),
    );

    const lockKeys = harness.transaction.$executeRaw.mock.calls.map(
      ([, lockKey]) => lockKey,
    );
    expect(lockKeys).toEqual([
      '1:previous-recipient-hash',
      '2:current-recipient-hash',
    ]);
    expect(harness.transaction.emailDestination.aggregate).toHaveBeenCalledWith(
      {
        where: {
          OR: recipientHashes.map(({ value, keyVersion }) => ({
            recipientHash: value,
            recipientHashKeyVersion: keyVersion,
          })),
        },
        _max: { suppressionRevision: true },
        _min: { suppressedAt: true },
      },
    );
    for (const hash of recipientHashes) {
      expect(harness.transaction.emailDestination.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            recipientHash: hash.value,
            recipientHashKeyVersion: hash.keyVersion,
            suppressionRevision: 4,
          }),
          update: { suppressionRevision: 4 },
        }),
      );
    }
    expect(
      harness.transaction.emailDestination.findFirstOrThrow,
    ).toHaveBeenCalledWith({
      where: {
        OR: recipientHashes.map(({ value, keyVersion }) => ({
          recipientHash: value,
          recipientHashKeyVersion: keyVersion,
        })),
      },
      orderBy: [
        { lastEventAt: { sort: 'desc', nulls: 'last' } },
        { lastEventRank: { sort: 'desc', nulls: 'last' } },
        { lastEventFingerprint: { sort: 'desc', nulls: 'last' } },
      ],
      select: {
        reasonCode: true,
        lastDeliveryId: true,
        lastEventId: true,
        lastEventAt: true,
        lastEventRank: true,
        lastEventFingerprint: true,
      },
    });
    expect(
      harness.transaction.emailDestination.updateMany,
    ).toHaveBeenLastCalledWith({
      where: {
        OR: recipientHashes.map(({ value, keyVersion }) => ({
          recipientHash: value,
          recipientHashKeyVersion: keyVersion,
        })),
      },
      data: {
        status: EmailDestinationStatus.SUPPRESSED,
        reasonCode: authoritativeDestination.reasonCode,
        suppressedAt: new Date(providerTimestamp),
        lastDeliveryId: authoritativeDestination.lastDeliveryId,
        lastEventId: authoritativeDestination.lastEventId,
        lastEventAt: authoritativeDestination.lastEventAt,
        lastEventRank: authoritativeDestination.lastEventRank,
        lastEventFingerprint: authoritativeDestination.lastEventFingerprint,
        suppressionRevision: 4,
      },
    });
  });

  it.each([
    {
      name: 'Delivery',
      event: {
        eventType: 'Delivery',
        delivery: { timestamp: providerTimestamp },
      },
      deliveryStatus: EmailDeliveryStatus.DELIVERED,
      destinationStatus: EmailDestinationStatus.ACTIVE,
    },
    {
      name: 'DeliveryDelay',
      event: {
        eventType: 'DeliveryDelay',
        deliveryDelay: {
          timestamp: providerTimestamp,
          delayType: 'MailboxFull',
        },
      },
      deliveryStatus: EmailDeliveryStatus.DELAYED,
      destinationStatus: EmailDestinationStatus.TEMPORARY_FAILURE,
    },
    {
      name: 'transient Bounce',
      event: {
        eventType: 'Bounce',
        bounce: {
          timestamp: providerTimestamp,
          bounceType: 'Transient',
          bounceSubType: 'MailboxFull',
          feedbackId: 'transient-bounce-id',
        },
      },
      deliveryStatus: EmailDeliveryStatus.BOUNCED,
      destinationStatus: EmailDestinationStatus.TEMPORARY_FAILURE,
    },
    {
      name: 'Reject',
      event: { eventType: 'Reject', reject: { reason: 'Bad content' } },
      deliveryStatus: EmailDeliveryStatus.REJECTED,
    },
    {
      name: 'Rendering Failure',
      event: {
        eventType: 'Rendering Failure',
        failure: {
          templateName: 'verify-email',
          errorMessage: 'Missing template attribute',
        },
      },
      deliveryStatus: EmailDeliveryStatus.FAILED,
    },
  ])(
    'applies the exact $name state transition',
    async ({ event, deliveryStatus, destinationStatus }) => {
      const harness = createHarness();

      await harness.processor.process(createFeedbackBody(event));

      expect(harness.transaction.emailDelivery.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: deliveryStatus }),
        }),
      );
      if (destinationStatus) {
        expect(
          harness.transaction.emailDestination.upsert,
        ).toHaveBeenCalledWith(
          expect.objectContaining({
            create: expect.objectContaining({ status: destinationStatus }),
          }),
        );
      } else {
        expect(
          harness.transaction.emailDestination.upsert,
        ).not.toHaveBeenCalled();
      }
    },
  );
  it('applies nonterminal feedback to every readable recipient alias under the same locks', async () => {
    const harness = createHarness();

    await harness.processor.process(
      createFeedbackBody({
        eventType: 'Delivery',
        delivery: { timestamp: providerTimestamp },
      }),
    );

    const lockKeys = harness.transaction.$executeRaw.mock.calls.map(
      ([, lockKey]) => lockKey,
    );
    expect(lockKeys).toEqual([
      '1:previous-recipient-hash',
      '2:current-recipient-hash',
    ]);
    expect(harness.transaction.emailDestination.upsert).toHaveBeenCalledTimes(
      recipientHashes.length,
    );
    for (const hash of recipientHashes) {
      expect(harness.transaction.emailDestination.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            recipientHash: hash.value,
            recipientHashKeyVersion: hash.keyVersion,
            status: EmailDestinationStatus.ACTIVE,
          }),
        }),
      );
    }
  });

  it('converges rotated aliases after nonterminal feedback', async () => {
    const authoritativeDestination = {
      status: EmailDestinationStatus.TEMPORARY_FAILURE,
      reasonCode: 'BOUNCE_TRANSIENT_GENERAL',
      lastDeliveryId: baseDelivery.id,
      lastEventId: 'event-id',
      lastEventAt: new Date('2026-08-08T11:00:00.000Z'),
      lastEventRank: 40,
      lastEventFingerprint: 'f'.repeat(64),
    };
    const harness = createHarness({ authoritativeDestination });
    const unblockedAliases = {
      status: {
        notIn: [
          EmailDestinationStatus.SUPPRESSED,
          EmailDestinationStatus.RECOVERY_PENDING,
        ],
      },
      OR: recipientHashes.map(({ value, keyVersion }) => ({
        recipientHash: value,
        recipientHashKeyVersion: keyVersion,
      })),
    };

    await harness.processor.process(
      createFeedbackBody({
        eventType: 'Delivery',
        delivery: { timestamp: providerTimestamp },
      }),
    );

    expect(
      harness.transaction.emailDestination.findFirstOrThrow,
    ).toHaveBeenCalledWith({
      where: unblockedAliases,
      orderBy: [
        { lastEventAt: { sort: 'desc', nulls: 'last' } },
        { lastEventRank: { sort: 'desc', nulls: 'last' } },
        { lastEventFingerprint: { sort: 'desc', nulls: 'last' } },
      ],
      select: {
        status: true,
        reasonCode: true,
        lastDeliveryId: true,
        lastEventId: true,
        lastEventAt: true,
        lastEventRank: true,
        lastEventFingerprint: true,
      },
    });
    expect(
      harness.transaction.emailDestination.updateMany,
    ).toHaveBeenLastCalledWith({
      where: unblockedAliases,
      data: authoritativeDestination,
    });
  });

  it('lets terminal feedback supersede newer nonterminal state', async () => {
    const harness = createHarness({
      delivery: {
        ...baseDelivery,
        status: EmailDeliveryStatus.DELIVERED,
        lastEventAt: new Date('2026-08-08T11:00:00.000Z'),
        lastEventRank: 30,
        lastEventFingerprint: 'f'.repeat(64),
      },
    });

    await harness.processor.process(
      createFeedbackBody({
        eventType: 'Complaint',
        complaint: {
          timestamp: providerTimestamp,
          feedbackId: 'complaint-id',
          complaintFeedbackType: 'abuse',
        },
      }),
    );

    expect(harness.transaction.emailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            {
              status: {
                notIn: [
                  EmailDeliveryStatus.BOUNCED,
                  EmailDeliveryStatus.COMPLAINED,
                  EmailDeliveryStatus.SUPPRESSED,
                ],
              },
            },
          ]),
        }),
        data: expect.objectContaining({
          status: EmailDeliveryStatus.COMPLAINED,
        }),
      }),
    );
  });

  it('does not let later nonterminal feedback replace terminal delivery state', async () => {
    const harness = createHarness({
      delivery: {
        ...baseDelivery,
        status: EmailDeliveryStatus.COMPLAINED,
        lastEventAt: new Date('2026-08-08T09:00:00.000Z'),
        lastEventRank: 60,
        lastEventFingerprint: 'a'.repeat(64),
      },
    });

    await harness.processor.process(
      createFeedbackBody({
        eventType: 'Delivery',
        delivery: { timestamp: providerTimestamp },
      }),
    );

    expect(harness.transaction.emailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: {
            notIn: [
              EmailDeliveryStatus.BOUNCED,
              EmailDeliveryStatus.COMPLAINED,
              EmailDeliveryStatus.SUPPRESSED,
            ],
          },
        }),
        data: expect.objectContaining({
          status: EmailDeliveryStatus.DELIVERED,
        }),
      }),
    );
  });
  it('persists an older event without allowing it to regress newer state', async () => {
    const harness = createHarness({
      delivery: {
        ...baseDelivery,
        status: EmailDeliveryStatus.DELIVERED,
        lastEventAt: new Date('2026-08-08T11:00:00.000Z'),
        lastEventRank: 30,
        lastEventFingerprint: 'f'.repeat(64),
      },
    });

    await harness.processor.process(
      createFeedbackBody({
        eventType: 'DeliveryDelay',
        deliveryDelay: {
          timestamp: providerTimestamp,
          delayType: 'MailboxFull',
        },
      }),
    );

    expect(harness.transaction.emailDeliveryEvent.create).toHaveBeenCalled();
    expect(harness.transaction.emailDelivery.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { lastEventAt: null },
            { lastEventAt: { lt: new Date(providerTimestamp) } },
            {
              lastEventAt: new Date(providerTimestamp),
              lastEventRank: { lt: 20 },
            },
          ]),
        }),
      }),
    );
    expect(
      harness.transaction.emailDestination.updateMany,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: expect.arrayContaining([
            { lastEventAt: null },
            { lastEventAt: { lt: new Date(providerTimestamp) } },
          ]),
        }),
      }),
    );
  });
  it.each([
    EmailDestinationStatus.SUPPRESSED,
    EmailDestinationStatus.RECOVERY_PENDING,
  ])('does not let Delivery reactivate a %s mailbox', async (status) => {
    const harness = createHarness({ blockedDestinationStatus: status });

    await harness.processor.process(
      createFeedbackBody({
        eventType: 'Delivery',
        delivery: { timestamp: providerTimestamp },
      }),
    );

    expect(harness.transaction.emailDestination.upsert).not.toHaveBeenCalled();
    expect(
      harness.transaction.emailDestination.updateMany,
    ).not.toHaveBeenCalled();
  });

  it('accepts semantic redelivery without inserting or transitioning twice', async () => {
    const harness = createHarness({ duplicateEvent: true });

    await expect(
      harness.processor.process(
        createFeedbackBody({ eventType: 'Send', send: {} }),
      ),
    ).resolves.toBe('DUPLICATE');

    expect(
      harness.transaction.emailDeliveryEvent.create,
    ).not.toHaveBeenCalled();
    expect(harness.transaction.emailDelivery.updateMany).not.toHaveBeenCalled();
  });

  it('rejects feedback whose request ID identifies a different delivery', async () => {
    const harness = createHarness({
      requestDelivery: {
        ...baseDelivery,
        id: '423e4567-e89b-42d3-a456-426614174000',
      },
    });

    await expect(
      harness.processor.process(
        createFeedbackBody({ eventType: 'Send', send: {} }),
      ),
    ).rejects.toBeInstanceOf(ConflictingSesFeedbackError);

    expect(
      harness.transaction.emailDeliveryEvent.create,
    ).not.toHaveBeenCalled();
  });
});

type HarnessOptions = {
  delivery?: EmailDelivery;
  findByMessageId?: EmailDelivery | null;
  requestDelivery?: EmailDelivery | null;
  duplicateEvent?: boolean;
  blockedDestinationStatus?: EmailDestinationStatus;
  maximumSuppressionRevision?: number;
  earliestSuppressedAt?: Date;
  authoritativeDestination?: Pick<
    EmailDestination,
    | 'reasonCode'
    | 'lastDeliveryId'
    | 'lastEventId'
    | 'lastEventAt'
    | 'lastEventRank'
    | 'lastEventFingerprint'
  > &
    Partial<Pick<EmailDestination, 'status'>>;
};

function createHarness(options: HarnessOptions = {}) {
  const delivery = options.delivery ?? baseDelivery;
  const transaction = {
    $executeRaw: jest.fn().mockResolvedValue(0),
    emailDelivery: {
      findUnique: jest.fn(({ where }: { where: Record<string, unknown> }) =>
        'providerMessageId' in where
          ? options.findByMessageId === undefined
            ? delivery
            : options.findByMessageId
          : options.requestDelivery === undefined
            ? delivery
            : options.requestDelivery,
      ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    emailDeliveryEvent: {
      findFirst: jest
        .fn()
        .mockImplementation(
          ({ where }: { where: { OR: Array<Record<string, string>> } }) => {
            if (!options.duplicateEvent) return null;
            return {
              id: 'event-id',
              deliveryId: delivery.id,
              semanticFingerprint: where.OR[1].semanticFingerprint,
            } as EmailDeliveryEvent;
          },
        ),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: EmailDeliveryEvent }) =>
          Promise.resolve({
            ...data,
            id: 'event-id',
            deliveryId: delivery.id,
          } as EmailDeliveryEvent),
        ),
    },
    emailDestination: {
      aggregate: jest.fn().mockResolvedValue({
        _max: {
          suppressionRevision: options.maximumSuppressionRevision ?? 0,
        },
        _min: { suppressedAt: options.earliestSuppressedAt ?? null },
      }),
      findFirstOrThrow: jest.fn().mockResolvedValue(
        options.authoritativeDestination ?? {
          status: EmailDestinationStatus.ACTIVE,
          reasonCode: 'BOUNCE_PERMANENT_GENERAL',
          lastDeliveryId: delivery.id,
          lastEventId: 'event-id',
          lastEventAt: new Date(providerTimestamp),
          lastEventRank: 50,
          lastEventFingerprint: 'f'.repeat(64),
        },
      ),
      findFirst: jest
        .fn()
        .mockResolvedValue(
          options.blockedDestinationStatus
            ? { id: 'destination-id', status: options.blockedDestinationStatus }
            : null,
        ),
      upsert: jest
        .fn()
        .mockImplementation(({ create }: { create: unknown }) =>
          Promise.resolve({ id: 'destination-id', ...(create as object) }),
        ),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };

  const prisma = {
    $transaction: jest.fn(
      (callback: (client: Prisma.TransactionClient) => Promise<unknown>) =>
        callback(transaction as unknown as Prisma.TransactionClient),
    ),
  } as unknown as PrismaService;
  const recipientHashService = {
    createLookupHashes: jest.fn().mockReturnValue(recipientHashes),
  } as unknown as RecipientHashService;
  const configService = {
    getOrThrow: jest.fn((name: keyof typeof source) => source[name]),
  } as unknown as ConfigService;

  return {
    processor: new SesFeedbackProcessor(
      prisma,
      recipientHashService,
      configService,
    ),
    transaction,
  };
}

function createFeedbackBody(providerEvent: Record<string, unknown>): string {
  const event = {
    ...providerEvent,
    mail: {
      timestamp: '2026-08-08T10:00:00.000Z',
      messageId: 'ses-message-id',
      sendingAccountId: source.SES_EXPECTED_ACCOUNT_ID,
      sourceArn: source.SES_EXPECTED_SOURCE_ARN,
      destination: ['User@example.com'],
      tags: {
        'ses:configuration-set': [source.SES_CONFIGURATION_SET],
        'request-id': [requestId],
      },
    },
  };

  return JSON.stringify({
    Type: 'Notification',
    MessageId: 'sns-message-id',
    TopicArn: source.SES_FEEDBACK_TOPIC_ARN,
    Message: JSON.stringify(event),
  });
}
