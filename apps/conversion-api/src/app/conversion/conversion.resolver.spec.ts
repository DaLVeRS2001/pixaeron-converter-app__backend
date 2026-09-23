import {
  EntitlementPlanCode,
  type EntitlementSnapshot,
} from '@pixaeron/entitlements-contract';
import type { HttpContext } from '@pixaeron/nestjs';

import {
  ConversionFileStatus,
  type ConversionFile as ConversionFileRow,
} from '../../generated/prisma/client';
import { ConversionResolver } from './conversion.resolver';

const proSnapshot: EntitlementSnapshot = {
  planCode: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_PRO,
  revision: 1,
  effectiveFromEpochMs: 0,
  maxBatchFiles: 20,
  maxFileBytes: 157286400,
  dailyFiles: undefined,
  maxConcurrentFiles: 8,
  queueTier: 3,
  minStartDelayMs: 0,
  outputRetentionHours: 48,
};

describe('ConversionResolver entitlement sizing', () => {
  const buildResolver = (snapshot: EntitlementSnapshot) => {
    const admission = {
      remainingToday: jest.fn(),
    };
    const entitlements = {
      getEntitlement: jest.fn().mockResolvedValue({ snapshot }),
    };
    const resolver = new ConversionResolver(
      admission as never,
      {} as never,
      entitlements as never,
      { subjectFor: () => 'anon:test' } as never,
      {} as never,
    );

    return { resolver, admission };
  };

  type SnapshotFor = (identity: {
    subject: string;
    userPublicId: string | null;
  }) => Promise<EntitlementSnapshot>;

  const snapshotFor = (
    resolver: ConversionResolver,
    userPublicId: string | null = null,
  ) =>
    (
      resolver as unknown as { entitlementSnapshotFor: SnapshotFor }
    ).entitlementSnapshotFor({ subject: 'anon:test', userPublicId });

  it('serves the plan ceiling untouched, large files included', async () => {
    const { resolver } = buildResolver(proSnapshot);

    const snapshot = await snapshotFor(resolver);

    expect(snapshot.maxFileBytes).toBe(157286400);
    expect(snapshot.maxBatchFiles).toBe(proSnapshot.maxBatchFiles);
  });

  it('reports an unreachable entitlements channel as retryable', async () => {
    const { resolver } = buildResolver(proSnapshot);
    (
      resolver as unknown as { entitlements: { getEntitlement: jest.Mock } }
    ).entitlements.getEntitlement.mockRejectedValue(
      new Error('14 UNAVAILABLE: no connection established'),
    );

    await expect(snapshotFor(resolver)).rejects.toMatchObject({
      status: 503,
      response: { code: 'ENTITLEMENTS_UNAVAILABLE' },
    });
  });

  it('asks entitlements for the signed-in subject, not the anonymous plan', async () => {
    const { resolver } = buildResolver(proSnapshot);
    const publicId = '3f2c1a84-9d5e-4b7a-8c6f-0e1d2a3b4c5d';

    await snapshotFor(resolver, publicId);

    expect(
      (resolver as unknown as { entitlements: { getEntitlement: jest.Mock } })
        .entitlements.getEntitlement,
    ).toHaveBeenCalledWith({ subject: publicId });
  });

  it('reports a stale session when the signed-in account is gone', async () => {
    const { resolver } = buildResolver(proSnapshot);
    (
      resolver as unknown as { entitlements: { getEntitlement: jest.Mock } }
    ).entitlements.getEntitlement.mockRejectedValue(
      Object.assign(new Error('5 NOT_FOUND: Unknown subject'), { code: 5 }),
    );

    await expect(
      snapshotFor(resolver, '3f2c1a84-9d5e-4b7a-8c6f-0e1d2a3b4c5d'),
    ).rejects.toMatchObject({
      status: 401,
      response: { code: 'SESSION_STALE' },
    });
  });

  it('rejects an entitlement response without a snapshot', async () => {
    const { resolver } = buildResolver(proSnapshot);
    (
      resolver as unknown as { entitlements: { getEntitlement: jest.Mock } }
    ).entitlements.getEntitlement.mockResolvedValue({});

    await expect(snapshotFor(resolver)).rejects.toThrow(
      'Entitlement response carried no snapshot',
    );
  });
});

describe('ConversionResolver request identity', () => {
  const resolver = new ConversionResolver(
    {} as never,
    {} as never,
    {} as never,
    { subjectFor: (ip: string) => `anon:${ip}` } as never,
    {} as never,
  );

  const identityFrom = (headers: Record<string, string | string[]>) =>
    (
      resolver as unknown as {
        identityFrom: (context: {
          req: {
            headers: Record<string, string | string[]>;
            ip: string;
            socket: object;
          };
        }) => { subject: string; userPublicId: string | null };
      }
    ).identityFrom({ req: { headers, ip: '203.0.113.9', socket: {} } });

  it('trusts the router-verified subject header', () => {
    const identity = identityFrom({
      'x-authenticated-sub': '3f2c1a84-9d5e-4b7a-8c6f-0e1d2a3b4c5d', // gitleaks:allow
    });

    expect(identity).toEqual({
      subject: 'user:3f2c1a84-9d5e-4b7a-8c6f-0e1d2a3b4c5d',
      userPublicId: '3f2c1a84-9d5e-4b7a-8c6f-0e1d2a3b4c5d',
    });
  });

  it('falls back to the anonymous identity without the header', () => {
    expect(identityFrom({})).toEqual({
      subject: 'anon:203.0.113.9',
      userPublicId: null,
    });
  });

  it('fails loud on a malformed subject header, which only a misconfig can send', () => {
    expect(() =>
      identityFrom({ 'x-authenticated-sub': 'user-1; DROP TABLE' }),
    ).toThrow(
      expect.objectContaining({
        status: 500,
        response: expect.objectContaining({ code: 'IDENTITY_HEADER_INVALID' }),
      }),
    );
  });
});

describe('ConversionResolver file listing', () => {
  const publicId = '3f2c1a84-9d5e-4b7a-8c6f-0e1d2a3b4c5d';
  const expiresAt = new Date('2026-09-26T10:00:00Z');

  const contextFor = (headers: Record<string, string>) =>
    ({
      req: { headers, ip: '203.0.113.9', socket: {} },
    }) as unknown as HttpContext;

  const signedIn = contextFor({ 'x-authenticated-sub': publicId });

  const storedFile = (
    overrides: Partial<ConversionFileRow> = {},
  ): ConversionFileRow => ({
    id: 'file-1',
    batchId: 'batch-1',
    status: ConversionFileStatus.COMPLETED,
    inputObjectKey: 'inputs/batch-1/file-1',
    inputEtag: 'etag',
    outputObjectKey: 'outputs/batch-1/file-1/1',
    inputFormat: 'jpeg',
    outputFormat: 'jpeg',
    inputBytes: BigInt(2048),
    outputBytes: BigInt(1024),
    outputChecksum: 'checksum',
    resultKind: 'SAVED',
    width: 10,
    height: 20,
    frameCount: 1,
    attempt: 1,
    failureCode: null,
    startedAt: null,
    completedAt: null,
    expiresAt,
    createdAt: new Date('2026-09-24T10:00:00Z'),
    updatedAt: new Date('2026-09-24T10:00:00Z'),
    ...overrides,
  });

  const buildResolver = (items: ConversionFileRow[], total = items.length) => {
    const admission = {
      listFiles: jest.fn().mockResolvedValue({ items, total }),
    };
    const storage = {
      presignDownload: jest.fn((objectKey: string) =>
        Promise.resolve(`https://bucket/${objectKey}?download`),
      ),
    };
    const resolver = new ConversionResolver(
      admission as never,
      {} as never,
      {} as never,
      { subjectFor: (ip: string) => `anon:${ip}` } as never,
      storage as never,
    );

    return { resolver, admission, storage };
  };

  it('refuses to list files for a visitor who is not signed in', async () => {
    const { resolver, admission } = buildResolver([]);

    await expect(
      resolver.myConversionFiles(null, null, contextFor({})),
    ).rejects.toMatchObject({
      status: 401,
      response: { code: 'UNAUTHENTICATED' },
    });
    expect(admission.listFiles).not.toHaveBeenCalled();
  });

  it.each([
    [null, null, 20, 0],
    [500, -3, 50, 0],
    [0, 7, 1, 7],
  ])(
    'clamps a page of limit %s at offset %s to %s from %s',
    async (limit, offset, expectedLimit, expectedOffset) => {
      const { resolver, admission } = buildResolver([]);

      await resolver.myConversionFiles(limit, offset, signedIn);

      expect(admission.listFiles).toHaveBeenCalledWith(
        `user:${publicId}`,
        expectedLimit,
        expectedOffset,
      );
    },
  );

  it('presigns the download for a stored result and passes the expiry through', async () => {
    const { resolver } = buildResolver([storedFile()], 7);

    const page = await resolver.myConversionFiles(null, null, signedIn);

    expect(page.total).toBe(7);
    expect(page.items).toEqual([
      expect.objectContaining({
        id: 'file-1',
        status: ConversionFileStatus.COMPLETED,
        outputBytes: 1024,
        downloadUrl: 'https://bucket/outputs/batch-1/file-1/1?download',
        expiresAt,
        upload: null,
      }),
    ]);
  });

  it('serves no download url until the result is stored', async () => {
    const { resolver, storage } = buildResolver([
      storedFile({ status: ConversionFileStatus.PROCESSING }),
    ]);

    const page = await resolver.myConversionFiles(null, null, signedIn);

    expect(page.items[0]).toMatchObject({
      status: ConversionFileStatus.PROCESSING,
      downloadUrl: null,
      expiresAt,
    });
    expect(storage.presignDownload).not.toHaveBeenCalled();
  });
});
