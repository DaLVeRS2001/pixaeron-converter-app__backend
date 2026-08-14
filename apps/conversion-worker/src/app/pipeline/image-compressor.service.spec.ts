import { ConfigService } from '@nestjs/config';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';

import { ImageCompressorService } from './image-compressor.service';

const service = (overrides: Record<string, string> = {}) =>
  new ImageCompressorService(
    new ConfigService({
      CONVERSION_LARGE_FILE_BYTES: '26214400',
      WORKER_MAX_PIXELS: '50000000',
      ...overrides,
    }),
  );

const noisyImage = (width: number, height: number) => {
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 42;
  for (let index = 0; index < pixels.length; index++) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    pixels[index] = seed % 256;
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } });
};

const gradientImage = (width: number, height: number) => {
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 3;
      pixels[offset] = (x * 255) / width;
      pixels[offset + 1] = (y * 255) / height;
      pixels[offset + 2] = ((x + y) * 255) / (width + height);
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } });
};

const GENEROUS_ENCODINGS = {
  jpeg: { quality: 100 },
  png: { compressionLevel: 0 },
  webp: { quality: 100, effort: 0 },
  avif: { quality: 100, effort: 1 },
} as const;

describe('ImageCompressorService', () => {
  it.each(['jpeg', 'png', 'webp', 'avif'] as const)(
    'compresses a generously encoded %s into a smaller file',
    async (format) => {
      const input = await gradientImage(200, 200)
        [format](GENEROUS_ENCODINGS[format])
        .toBuffer();

      const result = await service().compress(input);

      expect(result).toMatchObject({
        ok: true,
        kind: 'SAVED',
        format,
        width: 200,
        height: 200,
      });
      if (result.ok) {
        expect(result.bytes.length).toBeLessThan(input.length);
        expect((await sharp(result.bytes).metadata()).format).toBe(
          format === 'avif' ? 'heif' : format,
        );
      }
    },
  );

  it('returns the original bytes as NO_SAVINGS when clean input cannot shrink', async () => {
    const input = await sharp({
      create: {
        width: 8,
        height: 8,
        channels: 3,
        background: { r: 12, g: 200, b: 99 },
      },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const result = await service().compress(input);

    expect(result).toMatchObject({ ok: true, kind: 'NO_SAVINGS' });
    if (result.ok) expect(result.bytes.equals(input)).toBe(true);
  });

  it('returns the sanitized encoding when metadata-laden input grows', async () => {
    const input = await noisyImage(64, 64)
      .jpeg({ quality: 40 })
      .withExifMerge({ IFD0: { Copyright: 'Pixaeron fixture' } })
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const result = await service().compress(input);

    expect(result).toMatchObject({ ok: true, kind: 'SANITIZED_LARGER' });
    if (result.ok) {
      expect(result.bytes.equals(input)).toBe(false);
      expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
    }
  });

  it('normalizes EXIF orientation into the pixel data', async () => {
    const input = await noisyImage(20, 10)
      .jpeg({ quality: 90 })
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const result = await service().compress(input);

    expect(result).toMatchObject({ ok: true, width: 10, height: 20 });
    if (result.ok) {
      expect(
        (await sharp(result.bytes).metadata()).orientation,
      ).toBeUndefined();
    }
  });

  it('rejects unsupported formats', async () => {
    const input = await noisyImage(16, 16).gif().toBuffer();

    expect(await service().compress(input)).toEqual({
      ok: false,
      failureCode: 'UNSUPPORTED_FORMAT',
    });
  });

  it('rejects animated input', async () => {
    const frameA = await noisyImage(16, 16).png().toBuffer();
    const frameB = await gradientImage(16, 16).png().toBuffer();
    const animated = await sharp([frameA, frameB], {
      join: { animated: true },
    })
      .webp()
      .toBuffer();
    expect((await sharp(animated).metadata()).pages).toBeGreaterThan(1);

    expect(await service().compress(animated)).toEqual({
      ok: false,
      failureCode: 'ANIMATED_UNSUPPORTED',
    });
  });

  it('denies NO_SAVINGS to a JPEG carrying a comment segment', async () => {
    const clean = await gradientImage(24, 24).jpeg({ quality: 40 }).toBuffer();
    const comment = Buffer.from('private note', 'latin1');
    const segment = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from([(comment.length + 2) >> 8, (comment.length + 2) & 0xff]),
      comment,
    ]);
    const withComment = Buffer.concat([
      clean.subarray(0, 2),
      segment,
      clean.subarray(2),
    ]);
    const metadata = await sharp(withComment).metadata();
    expect(metadata.exif).toBeUndefined();

    const result = await service().compress(withComment);

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.kind).not.toBe('NO_SAVINGS');
      expect(result.bytes.equals(withComment)).toBe(false);
    }
  });

  it('denies NO_SAVINGS to a PNG carrying a text chunk', async () => {
    const clean = await gradientImage(64, 64)
      .png({ palette: true, colours: 16 })
      .toBuffer();
    const reencoded = await sharp(clean)
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
    expect(reencoded.length).toBeGreaterThan(clean.length + 64);
    const payload = Buffer.from('parameters\0secret prompt', 'latin1');
    const typeAndData = Buffer.concat([Buffer.from('tEXt', 'latin1'), payload]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(typeAndData));
    const chunk = Buffer.concat([
      Buffer.from([0, 0, 0, payload.length]),
      typeAndData,
      checksum,
    ]);
    const iendOffset = clean.length - 12;
    const withText = Buffer.concat([
      clean.subarray(0, iendOffset),
      chunk,
      clean.subarray(iendOffset),
    ]);
    expect((await sharp(withText).metadata()).format).toBe('png');

    const cleanResult = await service().compress(clean);
    expect(cleanResult).toMatchObject({ ok: true, kind: 'NO_SAVINGS' });

    const result = await service().compress(withText);

    expect(result).toMatchObject({ ok: true, kind: 'SANITIZED_LARGER' });
    if (result.ok) expect(result.bytes.equals(withText)).toBe(false);
  });

  it('denies NO_SAVINGS to a JPEG with bytes appended after EOI', async () => {
    const clean = await gradientImage(24, 24).jpeg({ quality: 40 }).toBuffer();
    expect(clean[clean.length - 2]).toBe(0xff);
    expect(clean[clean.length - 1]).toBe(0xd9);
    const withTrailer = Buffer.concat([
      clean,
      Buffer.from('hidden payload', 'latin1'),
    ]);

    const result = await service().compress(withTrailer);

    expect(result).toMatchObject({ ok: true, kind: 'SANITIZED_LARGER' });
    if (result.ok) expect(result.bytes.equals(withTrailer)).toBe(false);
  });

  it('denies NO_SAVINGS to a JPEG carrying a non-ICC APP2 segment', async () => {
    const clean = await gradientImage(24, 24).jpeg({ quality: 40 }).toBuffer();
    const payload = Buffer.from('MPF\0second-image', 'latin1');
    const segment = Buffer.concat([
      Buffer.from([
        0xff,
        0xe2,
        (payload.length + 2) >> 8,
        (payload.length + 2) & 0xff,
      ]),
      payload,
    ]);
    const withMpf = Buffer.concat([
      clean.subarray(0, 2),
      segment,
      clean.subarray(2),
    ]);

    const result = await service().compress(withMpf);

    expect(result).toMatchObject({ ok: true, kind: 'SANITIZED_LARGER' });
    if (result.ok) {
      expect(result.bytes.includes(Buffer.from('second-image', 'latin1'))).toBe(
        false,
      );
    }
  });

  it('never returns original bytes for webp, which has no byte-level scan', async () => {
    const clean = await gradientImage(64, 64).webp({ quality: 20 }).toBuffer();
    const privPayload = Buffer.from('private-riff-data', 'latin1');
    const privChunk = Buffer.concat([
      Buffer.from('PRIV', 'latin1'),
      (() => {
        const size = Buffer.alloc(4);
        size.writeUInt32LE(privPayload.length);
        return size;
      })(),
      privPayload,
      privPayload.length % 2 ? Buffer.from([0]) : Buffer.alloc(0),
    ]);
    const withPriv = Buffer.concat([clean, privChunk]);
    withPriv.writeUInt32LE(withPriv.length - 8, 4);
    expect((await sharp(withPriv).metadata()).format).toBe('webp');

    for (const input of [clean, withPriv]) {
      const result = await service().compress(input);
      expect(result).toMatchObject({ ok: true });
      if (result.ok && result.kind !== 'SAVED') {
        expect(result.kind).toBe('SANITIZED_LARGER');
        expect(result.bytes.equals(input)).toBe(false);
      }
    }
    const result = await service().compress(withPriv);
    if (result.ok) {
      expect(result.bytes.includes(Buffer.from('private-riff-data'))).toBe(
        false,
      );
    }
  });

  it('rejects undecodable bytes', async () => {
    expect(await service().compress(Buffer.from('not an image'))).toEqual({
      ok: false,
      failureCode: 'DECODE_FAILED',
    });
  });

  it('rejects oversized byte input before decoding', async () => {
    const input = await noisyImage(64, 64).jpeg().toBuffer();

    expect(
      await service({
        CONVERSION_LARGE_FILE_BYTES: '1048576',
      }).compress(Buffer.concat([input, Buffer.alloc(1_048_577)])),
    ).toEqual({ ok: false, failureCode: 'INPUT_TOO_LARGE' });
  });

  it('rejects images above the pixel budget', async () => {
    const input = await noisyImage(200, 200).jpeg().toBuffer();

    expect(
      await service({ WORKER_MAX_PIXELS: '1000000' }).compress(input),
    ).toMatchObject({ ok: true });
    const limited = new ImageCompressorService(
      new ConfigService({
        CONVERSION_LARGE_FILE_BYTES: '26214400',
        WORKER_MAX_PIXELS: '30000',
      }),
    );
    expect(await limited.compress(input)).toEqual({
      ok: false,
      failureCode: 'PIXELS_EXCEEDED',
    });
  });
});
