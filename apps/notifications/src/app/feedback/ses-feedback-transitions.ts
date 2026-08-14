import {
  EmailCommandResult,
  EmailDeliveryStatus,
  EmailDestinationStatus,
  Prisma,
  type EmailDelivery,
  type EmailDeliveryEvent,
} from '../../generated/prisma/client';
import { lockRecipientAliases } from '../delivery/recipient-advisory-lock';
import {
  recipientHashFilter,
  type RecipientHash,
} from '../delivery/recipient-hash.service';
import type { Transaction } from '../prisma/prisma.support';
import type { SesFeedback } from './ses-feedback-parser';
import {
  deliveryFailureCode,
  deliveryStatus,
  destinationStatus,
  feedbackPrecedence,
  isTerminalMailboxEvent,
} from './ses-feedback-policy';

const TERMINAL_DELIVERY_STATUSES = [
  EmailDeliveryStatus.BOUNCED,
  EmailDeliveryStatus.COMPLAINED,
  EmailDeliveryStatus.SUPPRESSED,
];
const BLOCKED_DESTINATION_STATUSES = [
  EmailDestinationStatus.SUPPRESSED,
  EmailDestinationStatus.RECOVERY_PENDING,
];

type EventRevision = {
  occurredAt: Date;
  rank: number;
  fingerprint: string;
};

export async function applySesFeedbackTransitions(
  transaction: Transaction,
  delivery: EmailDelivery,
  event: EmailDeliveryEvent,
  feedback: SesFeedback,
  recipientHashes: RecipientHash[],
): Promise<void> {
  const revision = createEventRevision(event, feedback);

  await recordProviderAcceptance(transaction, delivery.id, feedback);
  await applyDeliveryTransition(transaction, delivery.id, feedback, revision);
  await applyDestinationTransition(
    transaction,
    delivery,
    event.id,
    feedback,
    revision,
    recipientHashes,
  );
}

async function recordProviderAcceptance(
  transaction: Transaction,
  deliveryId: string,
  feedback: SesFeedback,
): Promise<void> {
  await transaction.emailDelivery.updateMany({
    where: { id: deliveryId, submittedAt: null },
    data: { submittedAt: feedback.mailTimestamp },
  });

  await transaction.emailDelivery.updateMany({
    where: { id: deliveryId, callerResult: null },
    data: {
      callerResult: EmailCommandResult.ACCEPTED,
      callerResultCode: null,
      leaseExpiresAt: null,
      finalizedAt: new Date(),
    },
  });
}

async function applyDeliveryTransition(
  transaction: Transaction,
  deliveryId: string,
  feedback: SesFeedback,
  revision: EventRevision,
): Promise<void> {
  const data = {
    status: deliveryStatus(feedback),
    failureCode: deliveryFailureCode(feedback),
    ...eventRevisionData(revision),
  };

  if (isTerminalMailboxEvent(feedback)) {
    await transaction.emailDelivery.updateMany({
      where: {
        id: deliveryId,
        OR: [
          { status: { notIn: TERMINAL_DELIVERY_STATUSES } },
          ...newerEventFilters(revision),
        ],
      },
      data,
    });
    return;
  }

  await transaction.emailDelivery.updateMany({
    where: {
      id: deliveryId,
      status: { notIn: TERMINAL_DELIVERY_STATUSES },
      OR: newerEventFilters(revision),
    },
    data,
  });
}

async function applyDestinationTransition(
  transaction: Transaction,
  delivery: EmailDelivery,
  eventId: string,
  feedback: SesFeedback,
  revision: EventRevision,
  recipientHashes: RecipientHash[],
): Promise<void> {
  const terminalMailboxEvent = isTerminalMailboxEvent(feedback);
  const nextStatus = destinationStatus(feedback);

  if (terminalMailboxEvent) {
    await lockRecipientAliases(transaction, recipientHashes);
    await suppressDestinationAliases(
      transaction,
      recipientHashes,
      delivery.id,
      eventId,
      feedback,
      revision,
    );
    return;
  }

  if (!nextStatus) return;

  await lockRecipientAliases(transaction, recipientHashes);

  const blockedDestination = await transaction.emailDestination.findFirst({
    where: {
      status: { in: BLOCKED_DESTINATION_STATUSES },
      OR: recipientHashFilter(recipientHashes),
    },
    select: { id: true },
  });
  if (blockedDestination) return;

  for (const recipientHash of recipientHashes) {
    await updateNonterminalDestination(
      transaction,
      recipientHash,
      delivery.id,
      eventId,
      feedback,
      revision,
      nextStatus,
    );
  }

  await convergeNonterminalAliases(transaction, recipientHashes);
}

async function convergeNonterminalAliases(
  transaction: Transaction,
  recipientHashes: RecipientHash[],
): Promise<void> {
  if (recipientHashes.length < 2) return;

  const recipientAliases = recipientHashFilter(recipientHashes);
  const unblockedAliases = {
    status: { notIn: BLOCKED_DESTINATION_STATUSES },
    OR: recipientAliases,
  };

  const authoritativeDestination = await findAuthoritativeDestination(
    transaction,
    unblockedAliases,
  );

  await transaction.emailDestination.updateMany({
    where: unblockedAliases,
    data: {
      status: authoritativeDestination.status,
      ...authoritativeDestinationData(authoritativeDestination),
    },
  });
}

async function suppressDestinationAliases(
  transaction: Transaction,
  recipientHashes: RecipientHash[],
  deliveryId: string,
  eventId: string,
  feedback: SesFeedback,
  revision: EventRevision,
): Promise<void> {
  const recipientAliases = recipientHashFilter(recipientHashes);

  const destinationState = await transaction.emailDestination.aggregate({
    where: { OR: recipientAliases },
    _max: { suppressionRevision: true },
    _min: { suppressedAt: true },
  });
  const nextSuppressionRevision =
    (destinationState._max.suppressionRevision ?? 0) + 1;

  for (const recipientHash of recipientHashes) {
    await suppressDestination(
      transaction,
      recipientHash,
      deliveryId,
      eventId,
      feedback,
      revision,
      nextSuppressionRevision,
    );
  }

  const authoritativeDestination = await findAuthoritativeDestination(
    transaction,
    { OR: recipientAliases },
  );
  const previousSuppressedAt = destinationState._min.suppressedAt;
  const earliestSuppressedAt =
    !previousSuppressedAt ||
    feedback.providerTimestamp.getTime() < previousSuppressedAt.getTime()
      ? feedback.providerTimestamp
      : previousSuppressedAt;

  await transaction.emailDestination.updateMany({
    where: { OR: recipientAliases },
    data: {
      status: EmailDestinationStatus.SUPPRESSED,
      ...authoritativeDestinationData(authoritativeDestination),
      suppressedAt: earliestSuppressedAt,
      suppressionRevision: nextSuppressionRevision,
    },
  });
}

async function findAuthoritativeDestination(
  transaction: Transaction,
  where: Prisma.EmailDestinationWhereInput,
) {
  return transaction.emailDestination.findFirstOrThrow({
    where,
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
}

function authoritativeDestinationData(
  destination: Awaited<ReturnType<typeof findAuthoritativeDestination>>,
) {
  return {
    reasonCode: destination.reasonCode,
    lastDeliveryId: destination.lastDeliveryId,
    lastEventId: destination.lastEventId,
    lastEventAt: destination.lastEventAt,
    lastEventRank: destination.lastEventRank,
    lastEventFingerprint: destination.lastEventFingerprint,
  };
}

async function suppressDestination(
  transaction: Transaction,
  recipientHash: RecipientHash,
  deliveryId: string,
  eventId: string,
  feedback: SesFeedback,
  revision: EventRevision,
  suppressionRevision: number,
): Promise<void> {
  const reasonCode = deliveryFailureCode(feedback);
  const destination = await transaction.emailDestination.upsert({
    where: destinationKey(recipientHash),
    create: {
      ...recipientHashData(recipientHash),
      status: EmailDestinationStatus.SUPPRESSED,
      reasonCode,
      suppressedAt: feedback.providerTimestamp,
      lastDeliveryId: deliveryId,
      lastEventId: eventId,
      ...eventRevisionData(revision),
      suppressionRevision,
    },
    update: { suppressionRevision },
  });

  await transaction.emailDestination.updateMany({
    where: {
      id: destination.id,
      OR: [
        { status: { not: EmailDestinationStatus.SUPPRESSED } },
        ...newerEventFilters(revision),
      ],
    },
    data: {
      status: EmailDestinationStatus.SUPPRESSED,
      reasonCode,
      lastDeliveryId: deliveryId,
      lastEventId: eventId,
      ...eventRevisionData(revision),
    },
  });

  await transaction.emailDestination.updateMany({
    where: {
      id: destination.id,
      OR: [
        { suppressedAt: null },
        { suppressedAt: { gt: feedback.providerTimestamp } },
      ],
    },
    data: { suppressedAt: feedback.providerTimestamp },
  });
}

async function updateNonterminalDestination(
  transaction: Transaction,
  recipientHash: RecipientHash,
  deliveryId: string,
  eventId: string,
  feedback: SesFeedback,
  revision: EventRevision,
  status: EmailDestinationStatus,
): Promise<void> {
  const reasonCode =
    status === EmailDestinationStatus.TEMPORARY_FAILURE
      ? deliveryFailureCode(feedback)
      : null;
  const revisionData = eventRevisionData(revision);

  await transaction.emailDestination.upsert({
    where: destinationKey(recipientHash),
    create: {
      ...recipientHashData(recipientHash),
      status,
      reasonCode,
      lastDeliveryId: deliveryId,
      lastEventId: eventId,
      ...revisionData,
    },
    update: {},
  });

  await transaction.emailDestination.updateMany({
    where: {
      ...recipientHashData(recipientHash),
      status: { notIn: BLOCKED_DESTINATION_STATUSES },
      OR: newerEventFilters(revision),
    },
    data: {
      status,
      reasonCode,
      lastDeliveryId: deliveryId,
      lastEventId: eventId,
      ...revisionData,
    },
  });
}

function createEventRevision(
  event: EmailDeliveryEvent,
  feedback: SesFeedback,
): EventRevision {
  return {
    occurredAt: feedback.providerTimestamp,
    rank: feedbackPrecedence(feedback),
    fingerprint: event.semanticFingerprint,
  };
}

function eventRevisionData(revision: EventRevision) {
  return {
    lastEventAt: revision.occurredAt,
    lastEventRank: revision.rank,
    lastEventFingerprint: revision.fingerprint,
  };
}

function newerEventFilters(revision: EventRevision) {
  return [
    { lastEventAt: null },
    { lastEventAt: { lt: revision.occurredAt } },
    { lastEventAt: revision.occurredAt, lastEventRank: null },
    {
      lastEventAt: revision.occurredAt,
      lastEventRank: { lt: revision.rank },
    },
    {
      lastEventAt: revision.occurredAt,
      lastEventRank: revision.rank,
      lastEventFingerprint: null,
    },
    {
      lastEventAt: revision.occurredAt,
      lastEventRank: revision.rank,
      lastEventFingerprint: { lt: revision.fingerprint },
    },
  ];
}

function destinationKey(recipientHash: RecipientHash) {
  return {
    recipientHash_recipientHashKeyVersion: recipientHashData(recipientHash),
  };
}

function recipientHashData(recipientHash: RecipientHash) {
  return {
    recipientHash: recipientHash.value,
    recipientHashKeyVersion: recipientHash.keyVersion,
  };
}
