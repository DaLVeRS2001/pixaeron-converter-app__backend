import {
  EmailCommandResult,
  EmailDeliveryStatus,
  Prisma,
} from '../../generated/prisma/client';

export function expiredLeaseFilter(
  expiredAt: Date,
): Prisma.EmailDeliveryWhereInput {
  return {
    status: EmailDeliveryStatus.PENDING,
    callerResult: null,
    leaseExpiresAt: { lte: expiredAt },
  };
}

export function expiredLeaseUpdate(
  expiredAt: Date,
): Prisma.EmailDeliveryUpdateManyMutationInput {
  return {
    status: EmailDeliveryStatus.SUBMISSION_UNKNOWN,
    callerResult: EmailCommandResult.SUBMISSION_UNKNOWN,
    callerResultCode: 'SUBMISSION_LEASE_EXPIRED',
    failureCode: 'SUBMISSION_LEASE_EXPIRED',
    leaseExpiresAt: null,
    finalizedAt: expiredAt,
  };
}
