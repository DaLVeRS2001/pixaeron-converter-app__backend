import { Prisma } from '../../generated/prisma/client';

export type Transaction = Prisma.TransactionClient;

export function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
