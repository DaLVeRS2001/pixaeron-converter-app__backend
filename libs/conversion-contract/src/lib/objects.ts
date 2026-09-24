export const outputObjectKey = (
  batchId: string,
  fileId: string,
  attempt: number,
): string => `outputs/${batchId}/${fileId}/${attempt}`;

export const previewObjectKey = (
  batchId: string,
  fileId: string,
  attempt: number,
): string => `${outputObjectKey(batchId, fileId, attempt)}/preview`;
