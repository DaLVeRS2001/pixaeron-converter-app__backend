import {
  ChecksumMode,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const UPLOAD_URL_TTL_SECONDS = 900;
const DOWNLOAD_URL_TTL_SECONDS = 300;

export type UploadTarget = {
  url: string;
  fields: Record<string, string>;
};

export type StoredObject = {
  bytes: number;
  etag: string;
  checksumSha256: string | null;
};

@Injectable()
export class InputObjectStorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(configService: ConfigService) {
    this.bucket = configService.getOrThrow<string>('CONVERSION_S3_BUCKET');
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
        requestTimeout: 25_000,
        throwOnRequestTimeout: true,
      },
    });
  }

  async presignUpload(
    objectKey: string,
    maxFileBytes: number,
  ): Promise<UploadTarget> {
    const presigned = await createPresignedPost(this.client, {
      Bucket: this.bucket,
      Key: objectKey,
      Conditions: [['content-length-range', 1, maxFileBytes]],
      Expires: UPLOAD_URL_TTL_SECONDS,
    });

    return { url: presigned.url, fields: presigned.fields };
  }

  async head(objectKey: string): Promise<StoredObject | null> {
    try {
      const head = await this.client.send(
        new HeadObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          ChecksumMode: ChecksumMode.ENABLED,
        }),
      );

      return {
        bytes: head.ContentLength ?? 0,
        etag: (head.ETag ?? '').replace(/"/g, ''),
        checksumSha256: head.ChecksumSHA256 ?? null,
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } })
        .$metadata?.httpStatusCode;
      if (status === 404) return null;
      throw error;
    }
  }

  presignDownload(objectKey: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
    );
  }
}
