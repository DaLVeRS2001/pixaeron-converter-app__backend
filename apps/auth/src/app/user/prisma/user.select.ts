import { Prisma } from '../../../generated/prisma/client';

export const authenticatedUserSelect = {
  id: true,
  email: true,
  username: true,
  planCode: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type AuthenticatedUser = Prisma.UserGetPayload<{
  select: typeof authenticatedUserSelect;
}>;
