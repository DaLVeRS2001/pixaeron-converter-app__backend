import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';

import { AuthTokenType } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const TOKEN_TTL_MS: Record<AuthTokenType, number> = {
  [AuthTokenType.EMAIL_VERIFICATION]: 24 * 60 * 60 * 1000,
  [AuthTokenType.PASSWORD_RESET]: 15 * 60 * 1000,
};

const TOKEN_TYPE_LOCK_ID: Record<AuthTokenType, number> = {
  [AuthTokenType.EMAIL_VERIFICATION]: 1,
  [AuthTokenType.PASSWORD_RESET]: 2,
};

@Injectable()
export class AuthTokenService {
  constructor(private readonly prisma: PrismaService) {}

  async issue(userId: number, type: AuthTokenType): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();

    await this.prisma.$transaction(async (transaction) => {
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
    });

    return token;
  }

  find(token: string, type: AuthTokenType) {
    return this.prisma.authToken.findFirst({
      where: { tokenHash: this.hash(token), type },
      include: { user: true },
    });
  }

  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
