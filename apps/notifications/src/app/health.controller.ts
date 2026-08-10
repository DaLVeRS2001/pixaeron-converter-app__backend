import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createConnection } from 'node:net';

import { PrismaService } from './prisma/prisma.service';

const GRPC_READINESS_TIMEOUT_MS = 500;

@Controller('health')
export class HealthController {
  private readonly grpcHost: string;
  private readonly grpcPort: number;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.grpcHost = configService.getOrThrow<string>('NOTIFICATIONS_GRPC_HOST');
    this.grpcPort = Number(
      configService.getOrThrow<string>('NOTIFICATIONS_GRPC_PORT'),
    );
  }

  @Get('live')
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  async ready() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      throw new ServiceUnavailableException(
        'Notifications database is unavailable',
      );
    }

    try {
      await connectToGrpcListener(this.grpcHost, this.grpcPort);
    } catch {
      throw new ServiceUnavailableException(
        'Notifications gRPC listener is unavailable',
      );
    }

    return { status: 'ok' };
  }
}

function connectToGrpcListener(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    socket.setTimeout(GRPC_READINESS_TIMEOUT_MS);

    socket.once('connect', () => {
      socket.destroy();
      resolve();
    });
    socket.once('error', reject);
    socket.once('timeout', () => {
      socket.destroy();
      reject(new Error('gRPC readiness check timed out'));
    });
  });
}
