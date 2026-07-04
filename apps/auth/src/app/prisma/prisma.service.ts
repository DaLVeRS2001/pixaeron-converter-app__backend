import { Injectable } from '@nestjs/common';
import { PrismaClient } from '../../generated/prisma/client';
import { createPrismaPgAdapter } from '@pixaeron/prisma';

@Injectable()
export class PrismaService extends PrismaClient {
  constructor() {
    super({
      adapter: createPrismaPgAdapter(process.env.DATABASE_URL as string),
    });
  }
}
