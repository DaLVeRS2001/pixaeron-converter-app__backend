import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OUTPUT_RETENTION_TAG,
  type ConversionFailureCode,
  type ConversionRetentionClass,
} from '@pixaeron/conversion-contract';

const TRANSFER_DEADLINE_MS = 60_000;

export class InputIntegrityError extends Error {
  constructor(
    readonly failureCode: Extract<
      ConversionFailureCode,
      'INPUT_CHANGED' | 'INPUT_MISSING' | 'INPUT_TOO_LARGE'
    >,
  ) {
    super(failureCode);
    this.name = 'InputIntegrityError';
  }
}

@Injectable()
export class WorkerObjectStorageService {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly maxInputBytes: number;

  constructor(configService: ConfigService) {
    this.bucket = configService.getOrThrow<string>('CONVERSION_S3_BUCKET');
    this.maxInputBytes = Number(
      configService.getOrThrow<string>('WORKER_MAX_INPUT_BYTES'),
    );
    this.client = new S3Client({
      region: configService.getOrThrow<string>('AWS_REGION'),
      credentials: {
        accessKeyId: configService.getOrThrow<string>('AWS_ACCESS_KEY_ID'),
        secretAccessKey: configService.getOrThrow<string>(
          'AWS_SECRET_ACCESS_KEY',
        ),
      },
      requestHandler: {
        connectionTimeout: 2_000,
        requestTimeout: 60_000,
        throwOnRequestTimeout: true,
      },
    });
  }

  async getInput(objectKey: string, expectedEtag: string): Promise<Buffer> {
    let body: Uint8Array;
    try {
      const object = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          IfMatch: `"${expectedEtag}"`,
        }),
        { abortSignal: AbortSignal.timeout(TRANSFER_DEADLINE_MS) },
      );
      if ((object.ContentLength ?? Infinity) > this.maxInputBytes) {
        throw new InputIntegrityError('INPUT_TOO_LARGE');
      }
      body = await object.Body!.transformToByteArray();
    } catch (error) {
      if (error instanceof InputIntegrityError) throw error;
      const name = (error as Error).name;
      if (name === 'AbortError' || name === 'TimeoutError') {
        throw new Error(`Input object read timed out: ${objectKey}`);
      }
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (name === 'NoSuchKey' || (status === 404 && name !== 'NoSuchBucket')) {
        throw new InputIntegrityError('INPUT_MISSING');
      }
      if (name === 'PreconditionFailed') {
        throw new InputIntegrityError('INPUT_CHANGED');
      }
      throw error;
    }

    return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  }

  async putOutput(
    objectKey: string,
    bytes: Buffer,
    contentType: string,
    checksumSha256: string,
    retention: ConversionRetentionClass,
  ): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: bytes,
          ContentType: contentType,
          ChecksumSHA256: checksumSha256,
          Tagging: `${OUTPUT_RETENTION_TAG}=${retention}`,
        }),
        { abortSignal: AbortSignal.timeout(TRANSFER_DEADLINE_MS) },
      );
    } catch (error) {
      const name = (error as Error).name;
      if (name === 'AbortError' || name === 'TimeoutError') {
        throw new Error(`Output object write timed out: ${objectKey}`);
      }
      throw error;
    }
  }
}
