export const outputObjectKey = (
  batchId: string,
  fileId: string,
  attempt: number,
): string => `outputs/${batchId}/${fileId}/${attempt}`;
