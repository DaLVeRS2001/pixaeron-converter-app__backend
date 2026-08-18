import {
  EntitlementPlanCode,
  type EntitlementSnapshot,
} from '@pixaeron/entitlements-contract';

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
      largeQueueBytes: 26214400,
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

  const cappedSnapshot = (
    resolver: ConversionResolver,
    userPublicId: string | null = null,
  ) =>
    (
      resolver as unknown as { snapshotCappedToServedSizes: SnapshotFor }
    ).snapshotCappedToServedSizes({ subject: 'anon:test', userPublicId });

  it('caps a plan ceiling above the large-file threshold', async () => {
    const { resolver } = buildResolver(proSnapshot);

    const snapshot = await cappedSnapshot(resolver);

    expect(snapshot.maxFileBytes).toBe(26214400);
    expect(snapshot.maxBatchFiles).toBe(proSnapshot.maxBatchFiles);
  });

  it('leaves a plan ceiling below the threshold untouched', async () => {
    const { resolver } = buildResolver({
      ...proSnapshot,
      planCode: EntitlementPlanCode.ENTITLEMENT_PLAN_CODE_ANONYMOUS,
      maxFileBytes: 5242880,
      queueTier: 0,
    });

    expect((await cappedSnapshot(resolver)).maxFileBytes).toBe(5242880);
  });

  it('reports an unreachable entitlements channel as retryable', async () => {
    const { resolver } = buildResolver(proSnapshot);
    (
      resolver as unknown as { entitlements: { getEntitlement: jest.Mock } }
    ).entitlements.getEntitlement.mockRejectedValue(
      new Error('14 UNAVAILABLE: no connection established'),
    );

    await expect(cappedSnapshot(resolver)).rejects.toMatchObject({
      status: 503,
      response: { code: 'ENTITLEMENTS_UNAVAILABLE' },
    });
  });

  it('asks entitlements for the signed-in subject, not the anonymous plan', async () => {
    const { resolver } = buildResolver(proSnapshot);
    const publicId = '3f2c1a84-9d5e-4b7a-8c6f-0e1d2a3b4c5d';

    await cappedSnapshot(resolver, publicId);

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
      cappedSnapshot(resolver, '3f2c1a84-9d5e-4b7a-8c6f-0e1d2a3b4c5d'),
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

    await expect(cappedSnapshot(resolver)).rejects.toThrow(
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
      'x-authenticated-sub': '3f2c1a84-9d5e-4b7a-8c6f-0e1d2a3b4c5d',
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
