import {
  ConversionBatchStatus,
  ConversionFileStatus,
  type Prisma,
} from '../../generated/prisma/client';

export const OPEN_BATCH_STATUSES = [
  ConversionBatchStatus.UPLOADING,
  ConversionBatchStatus.QUEUED,
  ConversionBatchStatus.PROCESSING,
];
const TERMINAL_FILE_STATUSES = new Set<ConversionFileStatus>([
  ConversionFileStatus.COMPLETED,
  ConversionFileStatus.FAILED,
  ConversionFileStatus.CANCELLED,
  ConversionFileStatus.EXPIRED,
]);

export const rollUpBatch = async (
  transaction: Prisma.TransactionClient,
  batchId: string,
): Promise<ConversionBatchStatus | null> => {
  const files = await transaction.conversionFile.findMany({
    where: { batchId },
    select: { status: true },
  });
  if (files.some(({ status }) => !TERMINAL_FILE_STATUSES.has(status))) {
    return null;
  }

  const counted = (wanted: ConversionFileStatus) =>
    files.filter(({ status }) => status === wanted).length;
  const completed = counted(ConversionFileStatus.COMPLETED);
  const allExpired = counted(ConversionFileStatus.EXPIRED) === files.length;
  const status = allExpired
    ? ConversionBatchStatus.EXPIRED
    : completed === files.length
      ? ConversionBatchStatus.COMPLETED
      : completed === 0
        ? ConversionBatchStatus.FAILED
        : ConversionBatchStatus.PARTIAL;

  const rolled = await transaction.conversionBatch.updateMany({
    where: {
      id: batchId,
      status: {
        in: allExpired
          ? [
              ...OPEN_BATCH_STATUSES,
              ConversionBatchStatus.COMPLETED,
              ConversionBatchStatus.PARTIAL,
            ]
          : OPEN_BATCH_STATUSES,
      },
    },
    data: { status },
  });

  return rolled.count === 1 ? status : null;
};
