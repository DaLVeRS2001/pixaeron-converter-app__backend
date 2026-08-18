import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IMAGE_FORMATS,
  isMember,
  type ConversionFailureCode,
  type ConversionImageFormat,
  type ConversionResultKindName,
} from '@pixaeron/conversion-contract';
import sharp, { type Metadata, type OutputInfo } from 'sharp';

export type CompressionResult =
  | {
      ok: true;
      kind: ConversionResultKindName;
      bytes: Buffer;
      format: ConversionImageFormat;
      contentType: string;
      frames: number;
      width: number;
      height: number;
    }
  | { ok: false; failureCode: ConversionFailureCode };

const CONTENT_TYPES: Record<ConversionImageFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
};

const JPEG_APP0 = 0xe0;
const JPEG_APP2 = 0xe2;
const ICC_PREFIX = Buffer.from('ICC_PROFILE\0', 'latin1');
const PNG_CLEAN_CHUNKS = new Set([
  'IHDR',
  'PLTE',
  'IDAT',
  'tRNS',
  'gAMA',
  'cHRM',
  'sRGB',
  'iCCP',
  'sBIT',
  'bKGD',
  'pHYs',
]);

@Injectable()
export class ImageCompressorService {
  private readonly maxInputBytes: number;
  private readonly maxPixels: number;

  constructor(configService: ConfigService) {
    this.maxInputBytes = Number(
      configService.getOrThrow<string>('WORKER_MAX_INPUT_BYTES'),
    );
    this.maxPixels = Number(
      configService.getOrThrow<string>('WORKER_MAX_PIXELS'),
    );
  }

  async compress(input: Buffer): Promise<CompressionResult> {
    if (input.length > this.maxInputBytes) {
      return { ok: false, failureCode: 'INPUT_TOO_LARGE' };
    }

    let metadata: Metadata;
    try {
      metadata = await sharp(input).metadata();
    } catch {
      return { ok: false, failureCode: 'DECODE_FAILED' };
    }

    const detected =
      metadata.format === 'heif'
        ? metadata.compression === 'av1'
          ? 'avif'
          : ''
        : (metadata.format ?? '');
    if (!isMember(IMAGE_FORMATS, detected)) {
      return { ok: false, failureCode: 'UNSUPPORTED_FORMAT' };
    }
    const format: ConversionImageFormat = detected;
    if ((metadata.pages ?? 1) > 1) {
      return { ok: false, failureCode: 'ANIMATED_UNSUPPORTED' };
    }
    if ((metadata.width ?? 0) * (metadata.height ?? 0) > this.maxPixels) {
      return { ok: false, failureCode: 'PIXELS_EXCEEDED' };
    }

    const sanitizedPipeline = () =>
      sharp(input, { limitInputPixels: this.maxPixels })
        .rotate()
        .keepIccProfile();

    let encoded: { data: Buffer; info: OutputInfo };
    try {
      let pipeline = sanitizedPipeline();
      switch (format) {
        case 'jpeg':
          pipeline = pipeline.jpeg({ quality: 75, mozjpeg: true });
          break;
        case 'png':
          pipeline = pipeline.png({
            compressionLevel: 9,
            adaptiveFiltering: true,
          });
          break;
        case 'webp':
          pipeline = pipeline.webp({ quality: 75, alphaQuality: 90 });
          break;
        case 'avif':
          pipeline = pipeline.avif({ quality: 50, effort: 4 });
          break;
        default: {
          const unencodable: never = format;
          throw new Error(`No encoder for ${String(unencodable)}`);
        }
      }
      encoded = await pipeline.toBuffer({ resolveWithObject: true });
    } catch {
      return { ok: false, failureCode: 'DECODE_FAILED' };
    }

    if (format === 'png') {
      const quantized = await sanitizedPipeline()
        .png({
          palette: true,
          quality: 65,
          effort: 7,
          compressionLevel: 9,
          adaptiveFiltering: true,
        })
        .toBuffer({ resolveWithObject: true })
        .catch(() => encoded);
      if (
        quantized.data.length < encoded.data.length &&
        quantized.data.length < input.length
      ) {
        encoded = quantized;
      }
    }

    const shape = {
      format,
      contentType: CONTENT_TYPES[format],
      frames: metadata.pages ?? 1,
      width: encoded.info.width,
      height: encoded.info.height,
    };
    if (encoded.data.length < input.length) {
      return { ok: true, kind: 'SAVED', bytes: encoded.data, ...shape };
    }

    const provablyClean =
      !metadata.exif &&
      !metadata.iptc &&
      !metadata.xmp &&
      (metadata.orientation ?? 1) === 1 &&
      this.bytesProvablyClean(format, input);
    if (provablyClean) {
      return { ok: true, kind: 'NO_SAVINGS', bytes: input, ...shape };
    }

    return {
      ok: true,
      kind: 'SANITIZED_LARGER',
      bytes: encoded.data,
      ...shape,
    };
  }

  private bytesProvablyClean(format: string, input: Buffer): boolean {
    if (format === 'jpeg') {
      if (
        input[input.length - 2] !== 0xff ||
        input[input.length - 1] !== 0xd9
      ) {
        return false;
      }
      let offset = 2;
      while (offset + 4 <= input.length) {
        if (input[offset] !== 0xff) return false;
        const marker = input[offset + 1];
        if (marker === 0xda) return true;
        if (marker >= 0xe0 && marker !== JPEG_APP0 && marker !== JPEG_APP2) {
          return false;
        }
        if (
          marker === JPEG_APP2 &&
          !input
            .subarray(offset + 4, offset + 4 + ICC_PREFIX.length)
            .equals(ICC_PREFIX)
        ) {
          return false;
        }
        offset += 2 + input.readUInt16BE(offset + 2);
      }
      return false;
    }

    if (format === 'png') {
      let offset = 8;
      while (offset + 8 <= input.length) {
        const length = input.readUInt32BE(offset);
        const chunkType = input.toString('latin1', offset + 4, offset + 8);
        if (chunkType === 'IEND') return offset + 12 + length === input.length;
        if (!PNG_CLEAN_CHUNKS.has(chunkType)) return false;
        offset += 12 + length;
      }
      return false;
    }

    return false;
  }
}
