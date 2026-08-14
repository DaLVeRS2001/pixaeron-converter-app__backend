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
      resultKind: 'SAVED' | 'NO_SAVINGS' | 'SANITIZED_LARGER';
      inputFormat: string;
      frameCount: number;
      outputObjectKey: string;
      outputBytes: number;
      outputChecksum: string;
      outputFormat: string;
      width: number;
      height: number;
    }
  | {
      outcome: 'FAILED';
      failureCode: string;
    }
);
