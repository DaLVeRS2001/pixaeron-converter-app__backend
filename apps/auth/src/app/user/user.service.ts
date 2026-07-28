import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { compare, hash } from 'bcryptjs';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const INVALID_PASSWORD = 'pixaeron-dummy-password-not-valid';

interface CreateLocalUserData {
  email: string;
  username: string;
  passwordHash: string;
  legalConsentVersion: string;
  legalConsentAcceptedAt: Date;
}

@Injectable()
export class UserService {
  private readonly passwordHashRounds: number;
  private readonly invalidPasswordHash: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    configService: ConfigService,
  ) {
    this.passwordHashRounds = Number(
      configService.getOrThrow('PASSWORD_HASH_ROUNDS'),
    );
    this.invalidPasswordHash = hash(INVALID_PASSWORD, this.passwordHashRounds);
  }

  createLocalUserInTransaction(
    transaction: Prisma.TransactionClient,
    data: CreateLocalUserData,
  ) {
    return transaction.user.create({
      data: {
        email: data.email,
        username: data.username,
        password: data.passwordHash,
        legalConsentVersion: data.legalConsentVersion,
        legalConsentAcceptedAt: data.legalConsentAcceptedAt,
      },
    });
  }

  hashPassword(password: string): Promise<string> {
    return hash(password, this.passwordHashRounds);
  }

  async verifyPassword(
    password: string,
    passwordHash: string | null | undefined,
  ): Promise<boolean> {
    // Keep unknown and passwordless accounts on the same bcrypt path as local accounts.
    const expectedHash = passwordHash ?? (await this.invalidPasswordHash);
    return compare(password, expectedHash);
  }

  getUser(where: Prisma.UserWhereUniqueInput) {
    return this.prisma.user.findUnique({ where });
  }
}
