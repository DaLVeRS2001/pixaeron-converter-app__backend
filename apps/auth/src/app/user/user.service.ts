import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hash } from 'bcryptjs';
import { Prisma } from '../../generated/prisma/client';
import { authenticatedUserSelect } from './prisma/user.select';

@Injectable()
export class UserService {
  constructor(private readonly prisma: PrismaService) {}

  async createUser(data: Prisma.UserCreateInput) {
    return this.prisma.user.create({
      data: {
        ...data,
        password: await hash(data.password, 10),
      },
    });
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
