import { Injectable } from '@nestjs/common';
import { hash } from 'bcryptjs';

import { Prisma } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { authenticatedUserSelect } from './prisma/user.select';

const PASSWORD_HASH_ROUNDS = 12;

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async createUser(data: Prisma.UserCreateInput) {
    return this.prisma.user.create({
      data: {
        ...data,
        password: data.password
          ? await this.hashPassword(data.password as string)
          : null,
      },
    });
  }

  hashPassword(password: string): Promise<string> {
    return hash(password, PASSWORD_HASH_ROUNDS);
  }

  async getUser(args: Prisma.UserWhereUniqueInput) {
    return this.prisma.user.findUnique({
      where: args,
    });
  }

  async getAuthenticatedUser(args: Prisma.UserWhereUniqueInput) {
    return this.prisma.user.findUnique({
      where: args,
      select: authenticatedUserSelect,
    });
  }
}
