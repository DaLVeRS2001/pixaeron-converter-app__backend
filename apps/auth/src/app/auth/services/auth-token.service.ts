import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

import { AuthTokenType, Prisma } from '../../../generated/prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const TOKEN_TTL_MS: Record<AuthTokenType, number> = {
  [AuthTokenType.EMAIL_VERIFICATION]: 24 * 60 * 60 * 1000,
  [AuthTokenType.PASSWORD_RESET]: 15 * 60 * 1000,
};

const TOKEN_TYPE_LOCK_ID: Record<AuthTokenType, number> = {
  [AuthTokenType.EMAIL_VERIFICATION]: 1,
  [AuthTokenType.PASSWORD_RESET]: 2,
};

type AuthTokenClient = Pick<Prisma.TransactionClient, 'authToken'>;

@Injectable()
export class AuthTokenService {
  constructor(private readonly prisma: PrismaService) {}

  async issueInTransaction(
    transaction: Prisma.TransactionClient,
    userId: number,
    type: AuthTokenType,
    now = new Date(),
  ): Promise<string> {
    const token = randomBytes(32).toString('base64url');

    await transaction.$executeRaw`
      SELECT pg_advisory_xact_lock(
        ${userId},
        ${TOKEN_TYPE_LOCK_ID[type]}
      )
    `;

    await transaction.authToken.updateMany({
      where: { userId, type, consumedAt: null },
      data: { consumedAt: now },
    });
    await transaction.authToken.create({
      data: {
        userId,
        type,
        tokenHash: this.hash(token),
        expiresAt: new Date(now.getTime() + TOKEN_TTL_MS[type]),
      },
    });

    return token;
  }

  find(token: string, type: AuthTokenType) {
    return this.findWithClient(this.prisma, token, type);
  }

  findInTransaction(
    transaction: Prisma.TransactionClient,
    token: string,
    type: AuthTokenType,
  ) {
    return this.findWithClient(transaction, token, type);
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  private findWithClient(
    client: AuthTokenClient,
    token: string,
    type: AuthTokenType,
  ) {
    return client.authToken.findFirst({
      where: { tokenHash: this.hash(token), type },
      include: { user: true },
    });
  }
}
