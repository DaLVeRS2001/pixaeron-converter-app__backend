export const RESULT_KINDS = [
  'SAVED',
  'NO_SAVINGS',
  'SANITIZED_LARGER',
] as const;

export const IMAGE_FORMATS = ['jpeg', 'png', 'webp', 'avif'] as const;

export const FAILURE_CODES = [
  'ANIMATED_UNSUPPORTED',
  'DECODE_FAILED',
  'INPUT_CHANGED',
  'INPUT_MISSING',
  'INPUT_TOO_LARGE',
  'PIXELS_EXCEEDED',
  'UNSUPPORTED_FORMAT',
] as const;

export type ConversionResultKindName = (typeof RESULT_KINDS)[number];
export type ConversionImageFormat = (typeof IMAGE_FORMATS)[number];
export type ConversionFailureCode = (typeof FAILURE_CODES)[number];

export const isMember = <T extends string>(
  values: readonly T[],
  value: unknown,
): value is T => values.includes(value as T);

export type ConversionRequestMessage = {
  fileId: string;
  batchId: string;
  inputObjectKey: string;
  inputEtag: string;
};

export type WorkerStartedEvent = {
  type: 'STARTED';
  fileId: string;
  batchId: string;
  attempt: number;
};

export type WorkerResultEvent = {
  type: 'RESULT';
  fileId: string;
  batchId: string;
  attempt: number;
} & (
  | {
      outcome: 'COMPLETED';
      resultKind: ConversionResultKindName;
      inputFormat: string;
      frameCount: number;
      outputObjectKey: string;
      outputBytes: number;
      outputChecksumSha256: string;
      outputFormat: string;
      width: number;
      height: number;
    }
  | {
      outcome: 'FAILED';
      failureCode: string;
    }
);
