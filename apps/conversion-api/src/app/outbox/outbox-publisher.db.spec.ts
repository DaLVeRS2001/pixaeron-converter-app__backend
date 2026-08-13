import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';

import { OutboxEventStatus } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { OutboxPublisherService } from './outbox-publisher.service';

describe('OutboxPublisherService on Postgres', () => {
  let prisma: PrismaService;
  let service: OutboxPublisherService;
  let secondService: OutboxPublisherService;
  let send: jest.Mock;
  let secondSend: jest.Mock;
  let eventIds: string[] = [];

  beforeAll(async () => {
    const configService = new ConfigService({
      DATABASE_URL: process.env['DATABASE_URL'],
      AWS_REGION: 'eu-central-1',
      AWS_ACCOUNT_ID: '123456789012',
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'example-secret-access-key-that-is-40-characters',
      SQS_QUEUE_SUFFIX: '-dev',
    });
    prisma = new PrismaService(configService);

    const pending = await prisma.outboxEvent.count({
      where: { status: OutboxEventStatus.PENDING },
    });
    if (pending > 0) {
      throw new Error(
        `outbox_events holds ${pending} pending rows; draining them into a mocked client would lose real events`,
      );
    }

    service = new OutboxPublisherService(prisma, configService);
    secondService = new OutboxPublisherService(prisma, configService);
    send = jest.fn();
    secondSend = jest.fn();
    (service as unknown as { client: { send: jest.Mock } }).client = { send };
    (secondService as unknown as { client: { send: jest.Mock } }).client = {
      send: secondSend,
    };
  });

  beforeEach(() => {
    for (const mock of [send, secondSend]) {
      mock.mockReset();
      mock.mockResolvedValue({});
    }
  });

  afterEach(async () => {
    await prisma.outboxEvent.deleteMany({ where: { id: { in: eventIds } } });
    eventIds = [];
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const seedEvents = async (count: number) => {
    const events = Array.from({ length: count }, () => ({
      id: randomUUID(),
      queue: 'pixaeron-conversion-anon',
      payload: { fileId: randomUUID(), marker: 'outbox-publisher-spec' },
    }));
    eventIds.push(...events.map(({ id }) => id));
    await prisma.outboxEvent.createMany({ data: events });
    return events;
  };

  const statuses = async () =>
    prisma.outboxEvent.findMany({
      where: { id: { in: eventIds } },
      select: { id: true, status: true, deliveredAt: true, attempts: true },
    });

  const seededSends = (mock = send) =>
    mock.mock.calls
      .map(([command]) => ({
        queueUrl: command.input.QueueUrl,
        payload: JSON.parse(command.input.MessageBody),
      }))
      .filter(({ payload }) => payload.marker === 'outbox-publisher-spec');

  it('delivers pending events across claim batches with suffixed queue URLs', async () => {
    const events = await seedEvents(12);

    await service.drain();

    const sent = seededSends();
    expect(sent).toHaveLength(12);
    for (const { queueUrl } of sent) {
      expect(queueUrl).toBe(
        'https://sqs.eu-central-1.amazonaws.com/123456789012/pixaeron-conversion-anon-dev',
      );
    }
    expect(sent.map(({ payload }) => payload.fileId).sort()).toEqual(
      events.map(({ payload }) => payload.fileId).sort(),
    );

    const rows = await statuses();
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row.status).toBe(OutboxEventStatus.DELIVERED);
      expect(row.deliveredAt).not.toBeNull();
    }
  });

  it('backs off a failing event without blocking the rest of the claim', async () => {
    await seedEvents(3);
    send.mockRejectedValueOnce(new Error('sqs unavailable'));

    await service.drain();

    let rows = await statuses();
    const failed = rows.filter(
      ({ status }) => status === OutboxEventStatus.PENDING,
    );
    expect(failed).toHaveLength(1);
    expect(failed[0].attempts).toBe(1);
    expect(
      rows.filter(({ status }) => status === OutboxEventStatus.DELIVERED),
    ).toHaveLength(2);

    await service.drain();

    rows = await statuses();
    expect(
      rows.filter(({ status }) => status === OutboxEventStatus.PENDING),
    ).toHaveLength(1);

    await prisma.$executeRaw`
      UPDATE "outbox_events"
      SET "next_attempt_at" = now() - interval '1 second'
      WHERE "id" = ${failed[0].id}
    `;
    await service.drain();

    rows = await statuses();
    expect(
      rows.filter(({ status }) => status === OutboxEventStatus.PENDING),
    ).toHaveLength(0);
  });

  it('keeps draining past failures and terminates when every send fails', async () => {
    await seedEvents(12);
    send.mockRejectedValue(new Error('queue missing'));

    await service.drain();

    expect(seededSends()).toHaveLength(12);
    const rows = await statuses();
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row.status).toBe(OutboxEventStatus.PENDING);
      expect(row.attempts).toBe(1);
    }
  });

  it('ignores events already delivered', async () => {
    const [event] = await seedEvents(1);
    await prisma.outboxEvent.update({
      where: { id: event.id },
      data: { status: OutboxEventStatus.DELIVERED, deliveredAt: new Date() },
    });

    await service.drain();

    expect(seededSends()).toHaveLength(0);
  });

  it('sends each event exactly once under concurrent publisher instances', async () => {
    await seedEvents(25);

    await Promise.all([service.drain(), secondService.drain()]);

    const sent = [...seededSends(send), ...seededSends(secondSend)];
    expect(sent).toHaveLength(25);
    const rows = await statuses();
    expect(rows).toHaveLength(25);
    for (const row of rows) {
      expect(row.status).toBe(OutboxEventStatus.DELIVERED);
    }
  });
});
