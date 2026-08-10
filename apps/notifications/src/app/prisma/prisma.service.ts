import {
  Injectable,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createPrismaPgAdapter } from '@pixaeron/prisma';

import { PrismaClient } from '../../generated/prisma/client';

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnApplicationShutdown
{
  constructor(config: ConfigService) {
    const connectionString = config.getOrThrow<string>('DATABASE_URL');

    super({
      adapter: createPrismaPgAdapter(connectionString),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$queryRaw`SELECT 1`;
  }

  // Disconnect on application shutdown, not module destroy: Nest tears the
  // transport down after onModuleDestroy but before onApplicationShutdown,
  // so disconnecting here keeps in-flight work served until the server itself
  // stops accepting it.
  async onApplicationShutdown(): Promise<void> {
    await this.$disconnect();
  }
}
