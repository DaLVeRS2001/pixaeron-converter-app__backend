import { ConfigService } from '@nestjs/config';
import { crc32 } from 'node:zlib';
import sharp from 'sharp';

import { ImageCompressorService } from './image-compressor.service';

const service = (overrides: Record<string, string> = {}) =>
  new ImageCompressorService(
    new ConfigService({
      WORKER_MAX_INPUT_BYTES: '26214400',
      WORKER_MAX_PIXELS: '50000000',
      WORKER_SLOTS: '1',
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

const artworkImage = (width: number, height: number) => {
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 7;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed;
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const block = Math.floor(y / 16) * 25 + Math.floor(x / 16);
      const offset = (y * width + x) * 3;
      pixels[offset] = (block * 97) % 256 ^ next() % 7;
      pixels[offset + 1] = (block * 57) % 256 ^ next() % 7;
      pixels[offset + 2] = (block * 17) % 256 ^ next() % 7;
    }
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

const pixels = (image: Buffer) => sharp(image).ensureAlpha().raw().toBuffer();

const riffChunk = (type: string, payload: Buffer) => {
  const header = Buffer.alloc(8);
  header.write(type, 0, 'latin1');
  header.writeUInt32LE(payload.length, 4);

  return Buffer.concat([
    header,
    payload,
    payload.length % 2 ? Buffer.from([0]) : Buffer.alloc(0),
  ]);
};

const scanBytes = async (image: Buffer) => {
  let offset = 2;
  while (image[offset + 1] !== 0xda)
    offset += 2 + image.readUInt16BE(offset + 2);
  return image.subarray(
    offset,
    image.indexOf(Buffer.from([0xff, 0xd9]), offset) + 2,
  );
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

      const result = await service().compress(input, 'LOSSY');

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

  it('quantizes a many-coloured png to a palette when that beats lossless', async () => {
    const input = await artworkImage(400, 400)
      .png({ compressionLevel: 1 })
      .toBuffer();

    const result = await service().compress(input, 'LOSSY');

    expect(result).toMatchObject({ ok: true, kind: 'SAVED', format: 'png' });
    if (result.ok) {
      const metadata = await sharp(result.bytes).metadata();
      expect(metadata.format).toBe('png');
      expect(metadata.isPalette).toBe(true);
      expect(result.bytes.length).toBeLessThan(input.length * 0.6);
    }
  });

  it('keeps the lossless encoding when the palette would inflate a smooth png', async () => {
    const input = await gradientImage(600, 400)
      .png({ compressionLevel: 1 })
      .toBuffer();

    const result = await service().compress(input, 'LOSSY');

    expect(result).toMatchObject({ ok: true, kind: 'SAVED', format: 'png' });
    if (result.ok) {
      expect((await sharp(result.bytes).metadata()).isPalette).toBe(false);
      expect(result.bytes.length).toBeLessThan(input.length);
    }
  });

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

    const result = await service().compress(input, 'LOSSY');

    expect(result).toMatchObject({ ok: true, kind: 'NO_SAVINGS' });
    if (result.ok) expect(result.bytes.equals(input)).toBe(true);
  });

  it('strips metadata byte for byte when a lossy re-encode would grow', async () => {
    const input = await noisyImage(64, 64)
      .jpeg({ quality: 40 })
      .withExifMerge({ IFD0: { Copyright: 'Pixaeron fixture' } })
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const result = await service().compress(input, 'LOSSY');

    expect(result).toMatchObject({ ok: true, kind: 'SAVED' });
    if (result.ok) {
      expect(result.bytes.length).toBeLessThan(input.length);
      expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
      expect(await scanBytes(result.bytes)).toEqual(await scanBytes(input));
    }
  });

  it('normalizes EXIF orientation into the pixel data when re-encoding', async () => {
    const input = await noisyImage(200, 100)
      .jpeg({ quality: 95 })
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const result = await service().compress(input, 'LOSSY');

    expect(result).toMatchObject({ ok: true, width: 100, height: 200 });
    if (result.ok) {
      expect(
        (await sharp(result.bytes).metadata()).orientation,
      ).toBeUndefined();
    }
  });

  it('keeps only the orientation when stripping a rotated JPEG losslessly', async () => {
    const input = await noisyImage(20, 10)
      .jpeg({ quality: 90 })
      .withExifMerge({ IFD0: { Copyright: 'Pixaeron fixture' } })
      .withMetadata({ orientation: 6 })
      .toBuffer();

    const result = await service().compress(input, 'LOSSLESS');

    expect(result).toMatchObject({
      ok: true,
      kind: 'SAVED',
      width: 10,
      height: 20,
    });
    if (result.ok) {
      const metadata = await sharp(result.bytes).metadata();
      expect(metadata.orientation).toBe(6);
      expect(result.bytes.includes(Buffer.from('Pixaeron fixture'))).toBe(
        false,
      );
      expect(await scanBytes(result.bytes)).toEqual(await scanBytes(input));
      expect(await service().compress(result.bytes, 'LOSSLESS')).toMatchObject({
        kind: 'NO_SAVINGS',
      });
    }
  });

  it('keeps the Adobe colour transform when stripping a CMYK JPEG losslessly', async () => {
    const input = await noisyImage(32, 32)
      .toColourspace('cmyk')
      .jpeg({ quality: 85 })
      .withExifMerge({ IFD0: { Copyright: 'Pixaeron fixture' } })
      .toBuffer();
    const before = await pixels(input);

    const result = await service().compress(input, 'LOSSLESS');

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.bytes.includes(Buffer.from('Pixaeron fixture'))).toBe(
        false,
      );
      expect(await pixels(result.bytes)).toEqual(before);
    }
  });

  it('encodes a few-coloured png to an exact palette in lossless mode', async () => {
    const fewColours = await gradientImage(192, 192)
      .png({ palette: true, colours: 6, dither: 0 })
      .toBuffer();
    const input = await sharp(fewColours)
      .png({ compressionLevel: 1 })
      .toBuffer();
    expect((await sharp(input).metadata()).isPalette).toBe(false);

    const result = await service().compress(input, 'LOSSLESS');

    expect(result).toMatchObject({ ok: true, kind: 'SAVED' });
    if (result.ok) {
      expect((await sharp(result.bytes).metadata()).isPalette).toBe(true);
      expect(await pixels(result.bytes)).toEqual(await pixels(input));
    }
  });

  it('never touches colours of a many-coloured png in lossless mode', async () => {
    const input = await artworkImage(400, 400)
      .png({ compressionLevel: 1 })
      .toBuffer();

    const result = await service().compress(input, 'LOSSLESS');

    expect(result).toMatchObject({ ok: true, kind: 'SAVED' });
    if (result.ok) {
      expect((await sharp(result.bytes).metadata()).isPalette).toBe(false);
      expect(await pixels(result.bytes)).toEqual(await pixels(input));
    }
  });

  it.each(['webp', 'avif'] as const)(
    'decodes to the same pixels after a lossless %s pass',
    async (format) => {
      const input = await gradientImage(64, 64)
        [format]({ lossless: true })
        .toBuffer();

      const result = await service().compress(input, 'LOSSLESS');

      expect(result).toMatchObject({ ok: true });
      if (result.ok)
        expect(await pixels(result.bytes)).toEqual(await pixels(input));
    },
  );

  it('never hands out a lossy webp larger than the lossless one for flat art', async () => {
    const input = await gradientImage(400, 400)
      .png({ palette: true, colours: 4, dither: 0 })
      .webp({ quality: 100, effort: 0 })
      .toBuffer();

    const lossy = await service().compress(input, 'LOSSY');
    const lossless = await service().compress(input, 'LOSSLESS');

    expect(lossy).toMatchObject({ ok: true });
    expect(lossless).toMatchObject({ ok: true });
    if (lossy.ok && lossless.ok) {
      expect(lossy.bytes.length).toBeLessThanOrEqual(lossless.bytes.length);
    }
  });

  it('trusts a clean avif but never an avif carrying EXIF', async () => {
    const clean = await gradientImage(48, 48)
      .avif({ quality: 50, effort: 2 })
      .toBuffer();
    const withExif = await sharp(clean)
      .withExifMerge({ IFD0: { Copyright: 'Pixaeron fixture' } })
      .avif({ quality: 50, effort: 2 })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const trusted = await service().compress(clean, 'LOSSY');
    expect(trusted).toMatchObject({ ok: true, kind: 'NO_SAVINGS' });

    const result = await service().compress(withExif, 'LOSSY');
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.kind).not.toBe('NO_SAVINGS');
      expect(result.bytes.includes(Buffer.from('Pixaeron fixture'))).toBe(
        false,
      );
    }
  });

  it('keeps EXIF inside an avif in lossless mode, where removing it would mean re-encoding', async () => {
    const withExif = await gradientImage(48, 48)
      .withExifMerge({ IFD0: { Copyright: 'Pixaeron fixture' } })
      .avif({ quality: 50, effort: 2 })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const result = await service().compress(withExif, 'LOSSLESS');

    expect(result).toMatchObject({ ok: true, kind: 'NO_SAVINGS' });
    if (result.ok) expect(result.bytes.equals(withExif)).toBe(true);
  });

  it('denies NO_SAVINGS to an avif carrying an extra top-level box', async () => {
    const clean = await gradientImage(48, 48)
      .avif({ quality: 50, effort: 2 })
      .toBuffer();
    const unknown = Buffer.alloc(24);
    unknown.writeUInt32BE(24);
    unknown.write('uuid', 4, 'latin1');
    const withUnknown = Buffer.concat([clean, unknown]);
    expect((await sharp(withUnknown).metadata()).format).toBe('heif');

    const result = await service().compress(withUnknown, 'LOSSY');

    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.kind).not.toBe('NO_SAVINGS');
  });

  it('trusts an avif padded with a free box instead of re-encoding it', async () => {
    const clean = await noisyImage(400, 300)
      .avif({ quality: 28, effort: 4 })
      .toBuffer();
    const padding = Buffer.alloc(64);
    padding.writeUInt32BE(64);
    padding.write('free', 4, 'latin1');
    const padded = Buffer.concat([clean, padding]);
    expect((await sharp(padded).metadata()).format).toBe('heif');

    const result = await service().compress(padded, 'LOSSY');

    expect(result).toMatchObject({ ok: true, kind: 'NO_SAVINGS' });
    if (result.ok) expect(result.bytes.equals(padded)).toBe(true);
  });

  it.each(['webp', 'avif'] as const)(
    'never hands back more bytes than it received for a %s in lossless mode',
    async (format) => {
      const input = await gradientImage(300, 300)
        .withExifMerge({ IFD0: { Copyright: 'Pixaeron fixture' } })
        [format]({ quality: format === 'webp' ? 75 : 50 })
        .toBuffer();
      expect((await sharp(input).metadata()).exif).toBeDefined();

      const result = await service().compress(input, 'LOSSLESS');

      expect(result).toMatchObject({ ok: true });
      if (result.ok)
        expect(result.bytes.length).toBeLessThanOrEqual(input.length);
    },
  );

  it.each(['webp', 'avif'] as const)(
    'removes EXIF from a %s in lossy mode even when cleaning costs bytes',
    async (format) => {
      const input = await noisyImage(400, 300)
        .withExifMerge({ IFD0: { Copyright: 'Pixaeron fixture' } })
        [format]({ quality: format === 'webp' ? 10 : 28, effort: 6 })
        .toBuffer();
      expect((await sharp(input).metadata()).exif).toBeDefined();

      const result = await service().compress(input, 'LOSSY');

      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        expect(result.kind).not.toBe('NO_SAVINGS');
        expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
      }
    },
  );

  it('strips EXIF from a webp without touching its pixels', async () => {
    const clean = await gradientImage(300, 300)
      .webp({ quality: 75 })
      .toBuffer();
    const input = await sharp(clean)
      .withExifMerge({ IFD0: { Copyright: 'Pixaeron fixture' } })
      .webp({ quality: 75 })
      .toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();

    const result = await service().compress(input, 'LOSSLESS');

    expect(result).toMatchObject({ ok: true, kind: 'SAVED' });
    if (result.ok) {
      expect((await sharp(result.bytes).metadata()).exif).toBeUndefined();
      expect(result.bytes.length).toBeLessThan(input.length);
      expect(await pixels(result.bytes)).toEqual(await pixels(input));
    }
  });

  it.each(['png', 'jpeg'] as const)(
    'refuses to shrink its own lossy %s output a second time',
    async (format) => {
      const source =
        format === 'jpeg' ? noisyImage(300, 300) : artworkImage(400, 400);
      const input = await source[format](GENEROUS_ENCODINGS[format]).toBuffer();
      const first = await service().compress(input, 'LOSSY');
      expect(first).toMatchObject({ ok: true, kind: 'SAVED' });
      if (!first.ok) return;

      const second = await service().compress(first.bytes, 'LOSSY');

      expect(second).toMatchObject({ ok: true, kind: 'NO_SAVINGS' });
      if (second.ok) expect(second.bytes.equals(first.bytes)).toBe(true);
    },
  );

  it('rejects unsupported formats', async () => {
    const input = await noisyImage(16, 16).gif().toBuffer();

    expect(await service().compress(input, 'LOSSY')).toEqual({
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

    expect(await service().compress(animated, 'LOSSY')).toEqual({
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

    const result = await service().compress(withComment, 'LOSSY');

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.kind).not.toBe('NO_SAVINGS');
      expect(result.bytes.equals(withComment)).toBe(false);
    }
  });

  it('denies NO_SAVINGS to a PNG carrying a text chunk', async () => {
    const clean = await gradientImage(192, 192)
      .png({
        palette: true,
        colours: 2,
        compressionLevel: 9,
        effort: 10,
        adaptiveFiltering: false,
      })
      .toBuffer();
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

    const cleanResult = await service().compress(clean, 'LOSSY');
    expect(cleanResult).toMatchObject({ ok: true, kind: 'NO_SAVINGS' });

    const result = await service().compress(withText, 'LOSSY');

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.kind).not.toBe('NO_SAVINGS');
      expect(result.bytes.equals(withText)).toBe(false);
      expect(
        result.bytes.includes(Buffer.from('secret prompt', 'latin1')),
      ).toBe(false);
    }
  });

  it('denies NO_SAVINGS to a JPEG with bytes appended after EOI', async () => {
    const clean = await gradientImage(24, 24).jpeg({ quality: 40 }).toBuffer();
    expect(clean[clean.length - 2]).toBe(0xff);
    expect(clean[clean.length - 1]).toBe(0xd9);
    const withTrailer = Buffer.concat([
      clean,
      Buffer.from('hidden payload', 'latin1'),
    ]);

    const result = await service().compress(withTrailer, 'LOSSY');

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.kind).not.toBe('NO_SAVINGS');
      expect(
        result.bytes.includes(Buffer.from('hidden payload', 'latin1')),
      ).toBe(false);
    }
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

    const result = await service().compress(withMpf, 'LOSSY');

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.kind).not.toBe('NO_SAVINGS');
      expect(result.bytes.includes(Buffer.from('second-image', 'latin1'))).toBe(
        false,
      );
    }
  });

  it('trusts a clean webp but never a webp carrying a private chunk', async () => {
    const clean = await gradientImage(64, 64).webp({ quality: 20 }).toBuffer();
    const privPayload = Buffer.from('private-riff-data', 'latin1');
    const withPriv = Buffer.concat([clean, riffChunk('PRIV', privPayload)]);
    withPriv.writeUInt32LE(withPriv.length - 8, 4);
    expect((await sharp(withPriv).metadata()).format).toBe('webp');

    const trusted = await service().compress(clean, 'LOSSY');
    expect(trusted).toMatchObject({ ok: true, kind: 'NO_SAVINGS' });
    if (trusted.ok) expect(trusted.bytes.equals(clean)).toBe(true);

    const result = await service().compress(withPriv, 'LOSSY');
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.kind).not.toBe('NO_SAVINGS');
      expect(result.bytes.includes(Buffer.from('private-riff-data'))).toBe(
        false,
      );
    }
  });

  it.each(['LOSSLESS', 'LOSSY'] as const)(
    'never hands back an undecodable webp when the container holds frames it cannot keep in %s mode',
    async (mode) => {
      const still = await gradientImage(64, 64)
        .webp({ quality: 80 })
        .toBuffer();
      const features = Buffer.alloc(10);
      features[0] = 0x02;
      features.writeUIntLE(63, 4, 3);
      features.writeUIntLE(63, 7, 3);
      const frame = Buffer.alloc(16);
      frame.writeUIntLE(63, 6, 3);
      frame.writeUIntLE(63, 9, 3);
      frame.writeUIntLE(100, 12, 3);
      const body = Buffer.concat([
        Buffer.from('WEBP', 'latin1'),
        riffChunk('VP8X', features),
        riffChunk('ANIM', Buffer.alloc(6)),
        riffChunk(
          'ANMF',
          Buffer.concat([frame, riffChunk('VP8 ', still.subarray(20))]),
        ),
      ]);
      const header = Buffer.alloc(8);
      header.write('RIFF', 0, 'latin1');
      header.writeUInt32LE(body.length, 4);
      const framed = Buffer.concat([header, body]);
      expect((await sharp(framed).metadata()).pages).toBe(1);

      const result = await service().compress(framed, mode);
      expect(result).toMatchObject({ ok: true });
      if (result.ok) {
        await expect(sharp(result.bytes).metadata()).resolves.toMatchObject({
          format: 'webp',
        });
      }
    },
  );

  it('survives an avif whose trailing box claims more bytes than it has', async () => {
    const clean = await noisyImage(96, 96)
      .avif({ quality: 30, effort: 4 })
      .toBuffer();
    const lyingMeta = Buffer.alloc(20);
    lyingMeta.writeUInt32BE(999999, 0);
    lyingMeta.write('meta', 4, 'latin1');
    lyingMeta.writeUInt32BE(888, 12);
    lyingMeta.write('iinf', 16, 'latin1');
    const withLyingMeta = Buffer.concat([clean, lyingMeta]);
    expect((await sharp(withLyingMeta).metadata()).format).toBe('heif');

    const result = await service().compress(withLyingMeta, 'LOSSY');

    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.kind).not.toBe('NO_SAVINGS');
  });

  it('drops a JFIF segment padded with bytes it does not declare', async () => {
    const base = await noisyImage(300, 200).jpeg({ quality: 80 }).toBuffer();
    const canonical = Buffer.alloc(14);
    canonical.write('JFIF\0', 0, 'latin1');
    canonical[5] = 1;
    canonical[6] = 1;
    canonical.writeUInt16BE(72, 8);
    canonical.writeUInt16BE(72, 10);
    const hidden = Buffer.from('hidden-jfif-payload', 'latin1');
    const segment = (payload: Buffer) => {
      const header = Buffer.from([0xff, 0xe0, 0, 0]);
      header.writeUInt16BE(payload.length + 2, 2);
      return Buffer.concat([
        base.subarray(0, 2),
        header,
        payload,
        base.subarray(2),
      ]);
    };

    const trusted = await service().compress(segment(canonical), 'LOSSLESS');
    expect(trusted).toMatchObject({ ok: true, kind: 'NO_SAVINGS' });

    const padded = await service().compress(
      segment(Buffer.concat([canonical, hidden])),
      'LOSSLESS',
    );
    expect(padded).toMatchObject({ ok: true });
    if (padded.ok) expect(padded.bytes.includes(hidden)).toBe(false);
  });

  it('denies NO_SAVINGS to a webp whose VP8X is not its declared size', async () => {
    const image = await noisyImage(300, 200).webp({ quality: 60 }).toBuffer();
    const hidden = Buffer.from('hidden-vp8x-payload', 'latin1');
    const features = Buffer.alloc(40);
    features.writeUIntLE(299, 4, 3);
    features.writeUIntLE(199, 7, 3);
    hidden.copy(features, 12);
    const header = Buffer.alloc(8);
    header.write('VP8X', 0, 'latin1');
    header.writeUInt32LE(features.length, 4);
    const body = Buffer.concat([
      Buffer.from('WEBP', 'latin1'),
      header,
      features,
      image.subarray(12),
    ]);
    const riff = Buffer.alloc(8);
    riff.write('RIFF', 0, 'latin1');
    riff.writeUInt32LE(body.length, 4);
    const fattened = Buffer.concat([riff, body]);
    expect((await sharp(fattened).metadata()).format).toBe('webp');

    const result = await service().compress(fattened, 'LOSSY');

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.kind).not.toBe('NO_SAVINGS');
      expect(result.bytes.includes(hidden)).toBe(false);
    }
  });

  it('keeps only the orientation when stripping a rotated webp losslessly', async () => {
    const secret = Buffer.from('rotated-webp-camera-data\0', 'latin1');
    const directory = Buffer.alloc(34);
    directory.write('MM', 0, 'latin1');
    directory.writeUInt16BE(42, 2);
    directory.writeUInt32BE(8, 4);
    directory.writeUInt16BE(2, 8);
    directory.writeUInt16BE(0x0112, 10);
    directory.writeUInt16BE(3, 12);
    directory.writeUInt32BE(1, 14);
    directory.writeUInt16BE(6, 18);
    directory.writeUInt16BE(0x8298, 22);
    directory.writeUInt16BE(2, 24);
    directory.writeUInt32BE(secret.length, 26);
    directory.writeUInt32BE(directory.length, 30);
    const still = await noisyImage(200, 100).webp({ quality: 70 }).toBuffer();
    const features = Buffer.alloc(10);
    features[0] = 0x08;
    features.writeUIntLE(199, 4, 3);
    features.writeUIntLE(99, 7, 3);
    const body = Buffer.concat([
      Buffer.from('WEBP', 'latin1'),
      riffChunk('VP8X', features),
      still.subarray(12),
      riffChunk('EXIF', Buffer.concat([directory, secret])),
    ]);
    const riff = Buffer.alloc(8);
    riff.write('RIFF', 0, 'latin1');
    riff.writeUInt32LE(body.length, 4);
    const rotated = Buffer.concat([riff, body]);
    expect((await sharp(rotated).metadata()).orientation).toBe(6);
    const before = await sharp(rotated).ensureAlpha().raw().toBuffer();

    const result = await service().compress(rotated, 'LOSSLESS');

    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.bytes.includes(secret.subarray(0, 24))).toBe(false);
      expect(result.width).toBe(100);
      expect(result.height).toBe(200);
      const kept = await sharp(result.bytes).metadata();
      expect(kept.orientation).toBe(6);
      expect(
        (await sharp(result.bytes).ensureAlpha().raw().toBuffer()).equals(
          before,
        ),
      ).toBe(true);
    }
  });

  it('rejects undecodable bytes', async () => {
    expect(
      await service().compress(Buffer.from('not an image'), 'LOSSY'),
    ).toEqual({
      ok: false,
      failureCode: 'DECODE_FAILED',
    });
  });

  it('rejects oversized byte input before decoding', async () => {
    const input = await noisyImage(64, 64).jpeg().toBuffer();

    expect(
      await service({
        WORKER_MAX_INPUT_BYTES: '1048576',
      }).compress(Buffer.concat([input, Buffer.alloc(1_048_577)]), 'LOSSY'),
    ).toEqual({ ok: false, failureCode: 'INPUT_TOO_LARGE' });
  });

  it('rejects images above the pixel budget', async () => {
    const input = await noisyImage(200, 200).jpeg().toBuffer();

    expect(
      await service({ WORKER_MAX_PIXELS: '1000000' }).compress(input, 'LOSSY'),
    ).toMatchObject({ ok: true });
    const limited = service({ WORKER_MAX_PIXELS: '30000' });
    expect(await limited.compress(input, 'LOSSY')).toEqual({
      ok: false,
      failureCode: 'PIXELS_EXCEEDED',
    });
  });
});
