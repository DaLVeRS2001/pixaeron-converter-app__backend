import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';

import {
  type EmailDelivery,
  type EmailDeliveryEvent,
} from '../../generated/prisma/client';
import {
  matchesRecipientHash,
  RecipientHashService,
  type RecipientHash,
} from '../delivery/recipient-hash.service';
import {
  isUniqueConstraintError,
  type Transaction,
} from '../prisma/prisma.support';
import { PrismaService } from '../prisma/prisma.service';
import {
  createSesFeedbackFingerprint,
  parseSesFeedback,
  type SesFeedback,
  type SesFeedbackSource,
} from './ses-feedback-parser';
import { eventSubtype, feedbackId, toEventType } from './ses-feedback-policy';
import { applySesFeedbackTransitions } from './ses-feedback-transitions';

type ProcessingResult = 'PROCESSED' | 'DUPLICATE';

export class UnmatchedSesFeedbackError extends Error {
  constructor() {
    super('SES feedback does not match a delivery');
  }
}

export class ConflictingSesFeedbackError extends Error {
  constructor() {
    super('SES feedback conflicts with the stored delivery');
  }
}

@Injectable()
export class SesFeedbackProcessor {
  private readonly expectedSource: SesFeedbackSource;

  constructor(
    private readonly prisma: PrismaService,
    private readonly recipientHashService: RecipientHashService,
    configService: ConfigService,
  ) {
    this.expectedSource = {
      topicArn: configService.getOrThrow<string>('SES_FEEDBACK_TOPIC_ARN'),
      sendingAccountId: configService.getOrThrow<string>(
        'SES_EXPECTED_ACCOUNT_ID',
      ),
      sourceArn: configService.getOrThrow<string>('SES_EXPECTED_SOURCE_ARN'),
      configurationSet: configService.getOrThrow<string>(
        'SES_CONFIGURATION_SET',
      ),
    };
  }

  async process(sqsBody: string): Promise<ProcessingResult> {
    const feedback = parseSesFeedback(sqsBody, this.expectedSource);
    const recipientHashes = this.recipientHashService.createLookupHashes(
      feedback.recipient,
    );

    try {
      return await this.prisma.$transaction((transaction) =>
        this.persist(transaction, feedback, recipientHashes),
      );
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;

      const isDuplicate = await this.prisma.$transaction((transaction) =>
        this.isCommittedDuplicate(transaction, feedback, recipientHashes),
      );
      if (!isDuplicate) throw error;

      return 'DUPLICATE';
    }
  }

  private async persist(
    transaction: Transaction,
    feedback: SesFeedback,
    recipientHashes: RecipientHash[],
  ): Promise<ProcessingResult> {
    const delivery = await findDelivery(transaction, feedback, recipientHashes);
    await attachProviderMessageId(transaction, delivery, feedback.sesMessageId);

    const fingerprint = createSesFeedbackFingerprint(
      feedback,
      delivery.recipientHash,
    );
    const duplicate = await findDuplicateEvent(
      transaction,
      feedback.snsMessageId,
      fingerprint,
    );

    if (duplicate) {
      assertSameEvent(duplicate, delivery.id, fingerprint);
      return 'DUPLICATE';
    }

    const event = await transaction.emailDeliveryEvent.create({
      data: {
        deliveryId: delivery.id,
        type: toEventType(feedback),
        snsMessageId: feedback.snsMessageId,
        providerFeedbackId: feedbackId(feedback),
        subtype: eventSubtype(feedback),
        providerMessageId: feedback.sesMessageId,
        semanticFingerprint: fingerprint,
        occurredAt: feedback.providerTimestamp,
      },
    });

    await applySesFeedbackTransitions(
      transaction,
      delivery,
      event,
      feedback,
      recipientHashes,
    );

    return 'PROCESSED';
  }

  private async isCommittedDuplicate(
    transaction: Transaction,
    feedback: SesFeedback,
    recipientHashes: RecipientHash[],
  ): Promise<boolean> {
    const delivery = await findDelivery(transaction, feedback, recipientHashes);
    const fingerprint = createSesFeedbackFingerprint(
      feedback,
      delivery.recipientHash,
    );
    const duplicate = await findDuplicateEvent(
      transaction,
      feedback.snsMessageId,
      fingerprint,
    );

    if (!duplicate) return false;
    assertSameEvent(duplicate, delivery.id, fingerprint);
    return true;
  }
}

async function findDelivery(
  transaction: Transaction,
  feedback: SesFeedback,
  recipientHashes: RecipientHash[],
): Promise<EmailDelivery> {
  const requestId = feedback.requestId;
  const hasValidRequestId = requestId !== undefined && isUUID(requestId, '4');

  const [byMessageId, byRequestId] = await Promise.all([
    transaction.emailDelivery.findUnique({
      where: { providerMessageId: feedback.sesMessageId },
    }),
    hasValidRequestId
      ? transaction.emailDelivery.findUnique({ where: { requestId } })
      : Promise.resolve(null),
  ]);

  if (requestId !== undefined && !hasValidRequestId) {
    throw new ConflictingSesFeedbackError();
  }
  if (byMessageId && byRequestId && byMessageId.id !== byRequestId.id) {
    throw new ConflictingSesFeedbackError();
  }

  const delivery = byMessageId ?? byRequestId;
  if (!delivery) throw new UnmatchedSesFeedbackError();

  const requestMatches = !requestId || delivery.requestId === requestId;
  const messageMatches =
    !delivery.providerMessageId ||
    delivery.providerMessageId === feedback.sesMessageId;
  const recipientMatches = matchesRecipientHash(delivery, recipientHashes);

  if (!requestMatches || !messageMatches || !recipientMatches) {
    throw new ConflictingSesFeedbackError();
  }

  return delivery;
}

async function attachProviderMessageId(
  transaction: Transaction,
  delivery: EmailDelivery,
  providerMessageId: string,
): Promise<void> {
  if (delivery.providerMessageId === providerMessageId) return;

  const attached = await transaction.emailDelivery.updateMany({
    where: {
      id: delivery.id,
      OR: [{ providerMessageId: null }, { providerMessageId }],
    },
    data: { providerMessageId },
  });

  if (attached.count !== 1) throw new ConflictingSesFeedbackError();
}

async function findDuplicateEvent(
  transaction: Transaction,
  snsMessageId: string,
  fingerprint: string,
): Promise<EmailDeliveryEvent | null> {
  return transaction.emailDeliveryEvent.findFirst({
    where: {
      OR: [{ snsMessageId }, { semanticFingerprint: fingerprint }],
    },
  });
}

function assertSameEvent(
  event: EmailDeliveryEvent,
  deliveryId: string,
  fingerprint: string,
): void {
  if (
    event.deliveryId !== deliveryId ||
    event.semanticFingerprint !== fingerprint
  ) {
    throw new ConflictingSesFeedbackError();
  }
}
