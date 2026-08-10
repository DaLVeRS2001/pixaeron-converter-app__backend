import { Prisma } from '../../generated/prisma/client';

/**
 * Interactive-transaction client shared by every service that runs inside a
 * `prisma.$transaction(...)` callback.
 */
export type Transaction = Prisma.TransactionClient;

/**
 * True when the error is a Prisma unique-constraint violation (P2002). Used to
 * turn a lost create race into an idempotent read of the existing row.
 */
export function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}
