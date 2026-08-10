import type { Prisma } from '../../generated/prisma/client';

import type { RecipientHash } from './recipient-hash.service';

export async function lockRecipientAliases(
  transaction: Prisma.TransactionClient,
  recipientHashes: readonly RecipientHash[],
): Promise<void> {
  const orderedHashes = [...recipientHashes].sort((left, right) => {
    const versionOrder = left.keyVersion - right.keyVersion;
    if (versionOrder !== 0) return versionOrder;
    if (left.value === right.value) return 0;
    return left.value < right.value ? -1 : 1;
  });

  for (const recipientHash of orderedHashes) {
    const lockKey = `${recipientHash.keyVersion}:${recipientHash.value}`;
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
  }
}
