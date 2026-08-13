import { createPrismaPgAdapter } from '@pixaeron/prisma';
import { randomBytes, randomUUID } from 'node:crypto';

import {
  EmailDeliveryEventType,
  EmailDestinationStatus,
  EmailPurpose,
  PrismaClient,
  type EmailDelivery,
} from '../../generated/prisma/client';
import type { RecipientHash } from '../delivery/recipient-hash.service';
import type { SesFeedback } from './ses-feedback-parser';
import { applySesFeedbackTransitions } from './ses-feedback-transitions';

const databaseUrl = process.env['DATABASE_URL'];

const T5 = new Date('2026-01-01T00:00:05Z');
const T10 = new Date('2026-01-01T00:00:10Z');
const T20 = new Date('2026-01-01T00:00:20Z');
const T30 = new Date('2026-01-01T00:00:30Z');

const hex = () => randomBytes(32).toString('hex');

describe('ses-feedback-transitions on Postgres', () => {
  let prisma: PrismaClient;
  let secondClient: PrismaClient;
  let aliases: RecipientHash[];

  beforeAll(() => {
    prisma = new PrismaClient({
      adapter: createPrismaPgAdapter(databaseUrl as string),
    });
    secondClient = new PrismaClient({
      adapter: createPrismaPgAdapter(databaseUrl as string),
    });
  });

  beforeEach(() => {
    aliases = [
      { value: hex(), keyVersion: 2 },
      { value: hex(), keyVersion: 1 },
    ];
  });

  afterEach(async () => {
    const aliasFilters = aliases.map(({ value, keyVersion }) => ({
      recipientHash: value,
      recipientHashKeyVersion: keyVersion,
    }));
    const deliveries = await prisma.emailDelivery.findMany({
      where: { OR: aliasFilters },
      select: { id: true },
    });
    const deliveryIds = deliveries.map(({ id }) => id);
    await prisma.emailDeliveryEvent.deleteMany({
      where: { deliveryId: { in: deliveryIds } },
    });
    await prisma.emailDelivery.deleteMany({
      where: { id: { in: deliveryIds } },
    });
    await prisma.emailDestination.deleteMany({ where: { OR: aliasFilters } });
  });

  afterAll(async () => {
    await prisma.$disconnect();
    await secondClient.$disconnect();
  });

  const createDelivery = (
    recipientHash: RecipientHash,
  ): Promise<EmailDelivery> =>
    prisma.emailDelivery.create({
      data: {
        requestId: randomUUID(),
        publicSubject: randomUUID(),
        recipientHash: recipientHash.value,
        recipientHashKeyVersion: recipientHash.keyVersion,
        purpose: EmailPurpose.EMAIL_VERIFICATION,
        contentVersion: 1,
        tokenFingerprint: hex(),
      },
    });

  const createEvent = (
    deliveryId: string,
    type: EmailDeliveryEventType,
    occurredAt: Date,
  ) =>
    prisma.emailDeliveryEvent.create({
      data: {
        deliveryId,
        type,
        providerMessageId: randomUUID(),
        semanticFingerprint: hex(),
        occurredAt,
      },
    });

  const feedbackFor = (
    eventType: 'DELIVERY' | 'DELIVERY_DELAY',
    providerTimestamp: Date,
  ): SesFeedback => {
    const base = {
      snsMessageId: randomUUID(),
      sesMessageId: randomUUID(),
      recipient: 'integration@example.com',
      mailTimestamp: T5,
      providerTimestamp,
    };

    return eventType === 'DELIVERY'
      ? { ...base, eventType }
      : { ...base, eventType, delayType: 'TransientCommunicationFailure' };
  };

  const readAliases = () =>
    prisma.emailDestination.findMany({
      where: {
        OR: aliases.map(({ value, keyVersion }) => ({
          recipientHash: value,
          recipientHashKeyVersion: keyVersion,
        })),
      },
      orderBy: { recipientHashKeyVersion: 'asc' },
      select: {
        recipientHashKeyVersion: true,
        status: true,
        reasonCode: true,
        lastEventAt: true,
        lastEventRank: true,
        lastEventFingerprint: true,
      },
    });

  it('converges a missing alias created by an out-of-order nonterminal event', async () => {
    const [activeAlias, retiredAlias] = aliases;
    const delivery = await createDelivery(retiredAlias);
    const staleFingerprint = hex();
    await prisma.emailDestination.create({
      data: {
        recipientHash: retiredAlias.value,
        recipientHashKeyVersion: retiredAlias.keyVersion,
        status: EmailDestinationStatus.TEMPORARY_FAILURE,
        reasonCode: 'DELIVERY_DELAYED',
        lastDeliveryId: delivery.id,
        lastEventAt: T10,
        lastEventRank: 20,
        lastEventFingerprint: staleFingerprint,
      },
    });
    const event = await createEvent(
      delivery.id,
      EmailDeliveryEventType.DELIVERY,
      T5,
    );

    await prisma.$transaction((transaction) =>
      applySesFeedbackTransitions(
        transaction,
        delivery,
        event,
        feedbackFor('DELIVERY', T5),
        [activeAlias, retiredAlias],
      ),
    );

    const rows = await readAliases();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe(EmailDestinationStatus.TEMPORARY_FAILURE);
      expect(row.lastEventAt).toEqual(T10);
      expect(row.lastEventRank).toBe(20);
      expect(row.lastEventFingerprint).toBe(staleFingerprint);
      expect(row.reasonCode).toBe('DELIVERY_DELAYED');
    }
  });

  it('keeps every alias identical under two concurrent transitions', async () => {
    const [activeAlias, retiredAlias] = aliases;
    const delayedDelivery = await createDelivery(activeAlias);
    const deliveredDelivery = await createDelivery(activeAlias);
    const delayedEvent = await createEvent(
      delayedDelivery.id,
      EmailDeliveryEventType.DELIVERY_DELAY,
      T20,
    );
    const deliveredEvent = await createEvent(
      deliveredDelivery.id,
      EmailDeliveryEventType.DELIVERY,
      T30,
    );

    await Promise.all([
      prisma.$transaction((transaction) =>
        applySesFeedbackTransitions(
          transaction,
          delayedDelivery,
          delayedEvent,
          feedbackFor('DELIVERY_DELAY', T20),
          [activeAlias, retiredAlias],
        ),
      ),
      secondClient.$transaction((transaction) =>
        applySesFeedbackTransitions(
          transaction,
          deliveredDelivery,
          deliveredEvent,
          feedbackFor('DELIVERY', T30),
          [activeAlias, retiredAlias],
        ),
      ),
    ]);

    const rows = await readAliases();
    expect(rows).toHaveLength(2);
    expect(rows[0].recipientHashKeyVersion).toBe(1);
    expect(rows[0].status).toBe(EmailDestinationStatus.ACTIVE);
    expect(rows[0].lastEventAt).toEqual(T30);
    expect(rows[1]).toEqual({ ...rows[0], recipientHashKeyVersion: 2 });
  });
});
