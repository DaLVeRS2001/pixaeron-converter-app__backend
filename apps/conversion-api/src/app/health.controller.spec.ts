import { ServiceUnavailableException } from '@nestjs/common';

import { HealthController } from './health.controller';

describe('HealthController', () => {
  const prisma = { $queryRaw: jest.fn() };
  const controller = new HealthController(prisma as never);

  beforeEach(() => jest.clearAllMocks());

  it('reports liveness unconditionally', () => {
    expect(controller.live()).toEqual({ status: 'ok' });
  });

  it('reports readiness when the database responds', async () => {
    prisma.$queryRaw.mockResolvedValue([{ ok: 1 }]);

    await expect(controller.ready()).resolves.toEqual({ status: 'ok' });
  });

  it('fails readiness when the database is unavailable', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('connection refused'));

    await expect(controller.ready()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });
});
