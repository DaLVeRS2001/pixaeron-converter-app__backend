import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  IMAGE_FORMATS,
  isMember,
  type ConversionFailureCode,
  type ConversionImageFormat,
  type ConversionModeName,
  type ConversionStrengthName,
  type ConversionResultKindName,
} from '@pixaeron/conversion-contract';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import sharp, { type Metadata, type Sharp } from 'sharp';

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
const JPEG_APP1 = 0xe1;
const JPEG_APP2 = 0xe2;
const JPEG_APP14 = 0xee;
const JPEG_APP15 = 0xef;
const JPEG_COMMENT = 0xfe;
const JPEG_SCAN = 0xda;
const JPEG_FILL = 0xff;
const JPEG_END = Buffer.from([0xff, 0xd9]);
const ICC_PREFIX = Buffer.from('ICC_PROFILE\0', 'latin1');
const ADOBE_PREFIX = Buffer.from('Adobe', 'latin1');
const EXIF_PREFIX = Buffer.from('Exif\0\0', 'latin1');
const JFIF_PREFIX = Buffer.from('JFIF\0', 'latin1');
const JFIF_FIXED_LENGTH = 14;
const JFIF_THUMB_AT = 12;
const EXIF_ORIENTATION_TAG = 0x0112;
const PALETTE_LIMIT = 256;
const LOSSY_MIN_SAVING = 0.1;
const LOSSY_QUALITY: Record<
  ConversionStrengthName,
  Record<ConversionImageFormat, number>
> = {
  LOW: { jpeg: 75, png: 60, webp: 75, avif: 50 },
  MEDIUM: { jpeg: 60, png: 35, webp: 60, avif: 38 },
  HIGH: { jpeg: 45, png: 10, webp: 35, avif: 30 },
};
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
  'cICP',
  'mDCv',
  'cLLi',
]);
const WEBP_CLEAN_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ICCP']);
const WEBP_HEADER = 12;
const WEBP_FEATURES_LENGTH = 10;
const WEBP_METADATA_FLAGS = 0x0c;
const WEBP_EXIF_FLAG = 0x08;
const WEBP_FEATURES_AT = 8;
const WEBP_IMAGE_CHUNKS = new Set(['VP8 ', 'VP8L']);
const AVIF_CLEAN_BOXES = new Set(['ftyp', 'meta', 'mdat', 'free', 'skip']);
const AVIF_CLEAN_ITEMS = new Set(['av01', 'grid']);
const ISOBMFF_FULL_BOX_HEADER = 12;

type Encoded = { data: Buffer; width: number; height: number };

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
    const slots = Number(configService.getOrThrow<string>('WORKER_SLOTS'));
    sharp.concurrency(Math.max(1, Math.floor(cpus().length / slots)));
  }

  async compress(
    input: Buffer,
    mode: ConversionModeName,
    strength: ConversionStrengthName,
  ): Promise<CompressionResult> {
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

    const pipeline = () =>
      sharp(input, { limitInputPixels: this.maxPixels })
        .rotate()
        .keepIccProfile();

    const encoders: Record<ConversionModeName, () => Promise<Encoded>> = {
      LOSSY: () =>
        this.encodeLossy(format, metadata, input, pipeline, strength),
      LOSSLESS: () => this.encodeLossless(format, metadata, input, pipeline),
    };

    try {
      const result = await encoders[mode]();
      const shape = {
        format,
        contentType: CONTENT_TYPES[format],
        frames: metadata.pages ?? 1,
        width: result.width,
        height: result.height,
      };
      if (result.data.length < input.length) {
        return { ok: true, kind: 'SAVED', bytes: result.data, ...shape };
      }

      const unchanged =
        result.data.equals(input) ||
        !this.carriesMetadata(format, metadata, input);
      if (unchanged) {
        return { ok: true, kind: 'NO_SAVINGS', bytes: input, ...shape };
      }

      return {
        ok: true,
        kind: 'SANITIZED_LARGER',
        bytes: result.data,
        ...shape,
      };
    } catch {
      return { ok: false, failureCode: 'DECODE_FAILED' };
    }
  }

  private async encodeLossy(
    format: ConversionImageFormat,
    metadata: Metadata,
    input: Buffer,
    pipeline: () => Sharp,
    strength: ConversionStrengthName,
  ): Promise<Encoded> {
    const quality = LOSSY_QUALITY[strength][format];
    const buysEnough = (candidate: Encoded) =>
      candidate.data.length <= input.length * (1 - LOSSY_MIN_SAVING);

    switch (format) {
      case 'jpeg': {
        const lossy = await encoded(
          pipeline().jpeg({ quality, mozjpeg: true }),
        );
        return buysEnough(lossy)
          ? lossy
          : this.encodeLossless(format, metadata, input, pipeline);
      }
      case 'png': {
        const lossless = await this.encodeLossless(
          format,
          metadata,
          input,
          pipeline,
        );
        if (metadata.isPalette) return lossless;
        const quantized = await this.repackPalette(
          await encoded(
            pipeline().png({
              palette: true,
              quality,
              effort: 10,
              compressionLevel: 9,
              adaptiveFiltering: false,
            }),
          ),
        );
        return quantized.data.length < lossless.data.length &&
          buysEnough(quantized)
          ? quantized
          : lossless;
      }
      case 'webp':
      case 'avif': {
        const lossy = await encoded(
          format === 'webp'
            ? pipeline().webp({ quality, alphaQuality: 90 })
            : pipeline().avif({ quality, effort: 4 }),
        );
        const lossless = await this.encodeLossless(
          format,
          metadata,
          input,
          pipeline,
        );
        if (buysEnough(lossy)) {
          return lossless.data.length <= lossy.data.length ? lossless : lossy;
        }
        if (!lossless.data.equals(input)) return lossless;

        return this.carriesMetadata(format, metadata, input) ? lossy : lossless;
      }
      default: {
        const unencodable: never = format;
        throw new Error(`No encoder for ${String(unencodable)}`);
      }
    }
  }

  private async encodeLossless(
    format: ConversionImageFormat,
    metadata: Metadata,
    input: Buffer,
    pipeline: () => Sharp,
  ): Promise<Encoded> {
    const orientation = metadata.orientation ?? 1;
    const displayed =
      orientation >= 5
        ? { width: metadata.height ?? 0, height: metadata.width ?? 0 }
        : { width: metadata.width ?? 0, height: metadata.height ?? 0 };

    switch (format) {
      case 'jpeg':
        return {
          data: this.rewriteJpegMetadata(input, orientation),
          ...displayed,
        };
      case 'png': {
        const deflated = await encoded(
          pipeline().png({ compressionLevel: 9, adaptiveFiltering: true }),
        );
        return (await this.fitsPalette(input))
          ? this.repackPalette(deflated)
          : deflated;
      }
      case 'webp':
        return {
          data: this.stripWebpMetadata(input, orientation),
          ...displayed,
        };
      case 'avif':
        return { data: input, ...displayed };
      default: {
        const unencodable: never = format;
        throw new Error(`No encoder for ${String(unencodable)}`);
      }
    }
  }

  private carriesMetadata(
    format: ConversionImageFormat,
    metadata: Metadata,
    input: Buffer,
  ): boolean {
    return (
      (metadata.orientation ?? 1) !== 1 ||
      Boolean(metadata.exif) ||
      Boolean(metadata.iptc) ||
      Boolean(metadata.xmp) ||
      !this.carriesOnlyAllowedTypes(format, input)
    );
  }

  private exifOrientationBlock(orientation: number): Buffer {
    const tiff = Buffer.alloc(26);
    tiff.write('II', 0, 'latin1');
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(EXIF_ORIENTATION_TAG, 10);
    tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(orientation, 18);
    tiff.writeUInt32LE(0, 22);

    return tiff;
  }

  private isCanonicalJfif(payload: Buffer): boolean {
    return (
      payload.subarray(0, JFIF_PREFIX.length).equals(JFIF_PREFIX) &&
      payload.length ===
        JFIF_FIXED_LENGTH +
          3 * payload[JFIF_THUMB_AT] * payload[JFIF_THUMB_AT + 1]
    );
  }

  private stripWebpMetadata(input: Buffer, orientation: number): Buffer {
    const kept: Buffer[] = [];
    let keptImage = false;
    let features: Buffer | null = null;
    let offset = WEBP_HEADER;
    while (offset + 8 <= input.length) {
      const chunkType = input.toString('latin1', offset, offset + 4);
      const length = input.readUInt32LE(offset + 4);
      const end = offset + 8 + length + (length % 2);
      if (end > input.length) return input;
      if (chunkType === 'VP8X' && length !== WEBP_FEATURES_LENGTH) return input;
      if (WEBP_CLEAN_CHUNKS.has(chunkType)) {
        const chunk = Buffer.from(input.subarray(offset, end));
        if (chunkType === 'VP8X') {
          chunk[WEBP_FEATURES_AT] &= ~WEBP_METADATA_FLAGS;
          features = chunk;
        }
        kept.push(chunk);
        keptImage = keptImage || WEBP_IMAGE_CHUNKS.has(chunkType);
      }
      offset = end;
    }
    if (offset !== input.length || !keptImage) return input;

    if (orientation !== 1) {
      if (!features) return input;
      features[WEBP_FEATURES_AT] |= WEBP_EXIF_FLAG;
      const exif = this.exifOrientationBlock(orientation);
      const header = Buffer.alloc(8);
      header.write('EXIF', 0, 'latin1');
      header.writeUInt32LE(exif.length, 4);
      kept.push(header, exif);
    }

    const body = Buffer.concat(kept);
    const header = Buffer.from(input.subarray(0, WEBP_HEADER));
    header.writeUInt32LE(body.length + 4, 4);

    return Buffer.concat([header, body]);
  }

  private async repackPalette(image: Encoded): Promise<Encoded> {
    const indexed = await encoded(
      sharp(image.data).png({
        palette: true,
        quality: 100,
        effort: 10,
        compressionLevel: 9,
        adaptiveFiltering: false,
        dither: 0,
      }),
    );
    if (indexed.data.length >= image.data.length) return image;
    const expected = await rawDigest(image.data);
    const actual = await rawDigest(indexed.data);

    return expected === actual ? indexed : image;
  }

  private async fitsPalette(input: Buffer): Promise<boolean> {
    const pixels = await sharp(input, { limitInputPixels: this.maxPixels })
      .ensureAlpha()
      .raw()
      .toBuffer();
    const seen = new Set<number>();
    for (let offset = 0; offset < pixels.length; offset += 4) {
      seen.add(pixels.readUInt32BE(offset));
      if (seen.size > PALETTE_LIMIT) return false;
    }

    return true;
  }

  private rewriteJpegMetadata(input: Buffer, orientation: number): Buffer {
    const kept = [input.subarray(0, 2)];
    if (orientation !== 1) {
      const body = Buffer.concat([
        EXIF_PREFIX,
        this.exifOrientationBlock(orientation),
      ]);
      const header = Buffer.from([0xff, JPEG_APP1, 0, 0]);
      header.writeUInt16BE(body.length + 2, 2);
      kept.push(header, body);
    }
    let offset = 2;
    while (offset + 4 <= input.length) {
      if (input[offset] !== 0xff) throw new Error('JPEG marker expected');
      const marker = input[offset + 1];
      if (marker === JPEG_FILL) {
        offset++;
        continue;
      }
      if (marker === JPEG_SCAN) {
        const end = input.indexOf(JPEG_END, offset);
        if (end === -1) throw new Error('JPEG end marker not found');
        kept.push(input.subarray(offset, end + JPEG_END.length));
        return Buffer.concat(kept);
      }
      const segment = input.subarray(
        offset,
        offset + 2 + input.readUInt16BE(offset + 2),
      );
      const payload = segment.subarray(4);
      const application = marker >= JPEG_APP0 && marker <= JPEG_APP15;
      const decodingHint =
        (marker === JPEG_APP0 && this.isCanonicalJfif(payload)) ||
        (marker === JPEG_APP2 &&
          payload.subarray(0, ICC_PREFIX.length).equals(ICC_PREFIX)) ||
        (marker === JPEG_APP14 &&
          payload.subarray(0, ADOBE_PREFIX.length).equals(ADOBE_PREFIX));
      if ((!application && marker !== JPEG_COMMENT) || decodingHint) {
        kept.push(segment);
      }
      offset += segment.length;
    }
    throw new Error('JPEG scan not found');
  }

  private carriesOnlyAllowedTypes(
    format: ConversionImageFormat,
    input: Buffer,
  ): boolean {
    switch (format) {
      case 'jpeg':
        return this.rewriteJpegMetadata(input, 1).equals(input);
      case 'png': {
        let offset = 8;
        while (offset + 8 <= input.length) {
          const length = input.readUInt32BE(offset);
          const chunkType = input.toString('latin1', offset + 4, offset + 8);
          if (chunkType === 'IEND') {
            return offset + 12 + length === input.length;
          }
          if (!PNG_CLEAN_CHUNKS.has(chunkType)) return false;
          offset += 12 + length;
        }

        return false;
      }
      case 'webp': {
        if (input.readUInt32LE(4) + 8 !== input.length) return false;
        let offset = WEBP_HEADER;
        while (offset + 8 <= input.length) {
          const chunkType = input.toString('latin1', offset, offset + 4);
          if (!WEBP_CLEAN_CHUNKS.has(chunkType)) return false;
          const length = input.readUInt32LE(offset + 4);
          if (chunkType === 'VP8X' && length !== WEBP_FEATURES_LENGTH) {
            return false;
          }
          offset += 8 + length + (length % 2);
        }

        return offset === input.length;
      }
      case 'avif': {
        const items: string[] = [];
        let offset = 0;
        while (offset + 8 <= input.length) {
          const length = input.readUInt32BE(offset);
          const boxType = input.toString('latin1', offset + 4, offset + 8);
          if (!AVIF_CLEAN_BOXES.has(boxType) || length < 8) return false;
          const boxEnd = Math.min(offset + length, input.length);
          let child = offset + ISOBMFF_FULL_BOX_HEADER;
          while (boxType === 'meta' && child + 8 <= boxEnd) {
            const childLength = input.readUInt32BE(child);
            if (childLength < 8) return false;
            if (input.toString('latin1', child + 4, child + 8) === 'iinf') {
              const countBytes = input[child + 8] === 0 ? 2 : 4;
              const iinfEnd = Math.min(child + childLength, input.length);
              let entry = child + ISOBMFF_FULL_BOX_HEADER + countBytes;
              while (entry + ISOBMFF_FULL_BOX_HEADER <= iinfEnd) {
                const entryLength = input.readUInt32BE(entry);
                if (
                  input.toString('latin1', entry + 4, entry + 8) !== 'infe' ||
                  entryLength < ISOBMFF_FULL_BOX_HEADER + 8
                ) {
                  return false;
                }
                const idBytes = input[entry + 8] === 2 ? 2 : 4;
                const typeAt = entry + ISOBMFF_FULL_BOX_HEADER + idBytes + 2;
                items.push(input.toString('latin1', typeAt, typeAt + 4));
                entry += entryLength;
              }
            }
            child += childLength;
          }
          offset += length;
        }

        return (
          offset === input.length &&
          items.length > 0 &&
          items.every((item) => AVIF_CLEAN_ITEMS.has(item))
        );
      }
      default: {
        const unwalkable: never = format;
        throw new Error(`No cleanliness walk for ${String(unwalkable)}`);
      }
    }
  }
}

const encoded = async (pipeline: Sharp): Promise<Encoded> => {
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};

const rawDigest = async (image: Buffer): Promise<string> => {
  const pixels = await sharp(image).ensureAlpha().raw().toBuffer();
  return createHash('sha256').update(pixels).digest('hex');
};
