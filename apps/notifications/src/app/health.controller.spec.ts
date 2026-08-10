import { ConfigService } from '@nestjs/config';
import { type AddressInfo, createServer, type Server } from 'node:net';

import { HealthController } from './health.controller';
import { PrismaService } from './prisma/prisma.service';

describe('HealthController', () => {
  const prisma = {
    $queryRaw: jest.fn(),
  };
  let grpcServer: Server;
  let grpcPort: number;

  beforeEach(async () => {
    jest.clearAllMocks();
    prisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

    grpcServer = createServer();
    await new Promise<void>((resolve) => {
      grpcServer.listen(0, '127.0.0.1', resolve);
    });
    grpcPort = (grpcServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    if (!grpcServer.listening) return;

    await new Promise<void>((resolve, reject) => {
      grpcServer.close((error) => (error ? reject(error) : resolve()));
    });
  });

  it('reports the process as live without querying dependencies', () => {
    const controller = createController(grpcPort);

    expect(controller.live()).toEqual({ status: 'ok' });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('reports readiness after PostgreSQL and gRPC respond', async () => {
    const controller = createController(grpcPort);

    await expect(controller.ready()).resolves.toEqual({ status: 'ok' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('fails readiness when PostgreSQL is unavailable', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('PostgreSQL unavailable'));
    const controller = createController(grpcPort);

    await expect(controller.ready()).rejects.toMatchObject({
      status: 503,
      message: 'Notifications database is unavailable',
    });
  });

  it('fails readiness when the gRPC listener is unavailable', async () => {
    await new Promise<void>((resolve, reject) => {
      grpcServer.close((error) => (error ? reject(error) : resolve()));
    });
    const controller = createController(grpcPort);

    await expect(controller.ready()).rejects.toMatchObject({
      status: 503,
      message: 'Notifications gRPC listener is unavailable',
    });
  });

  function createController(port: number): HealthController {
    const config = new ConfigService({
      NOTIFICATIONS_GRPC_HOST: '127.0.0.1',
      NOTIFICATIONS_GRPC_PORT: String(port),
    });

    return new HealthController(prisma as unknown as PrismaService, config);
  }
});
