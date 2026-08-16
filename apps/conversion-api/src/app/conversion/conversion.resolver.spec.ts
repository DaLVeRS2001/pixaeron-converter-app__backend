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
      largeFileBytes: 26214400,
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

  const cappedSnapshot = (resolver: ConversionResolver) =>
    (
      resolver as unknown as {
        anonymousSnapshotCappedToServedSizes: () => Promise<EntitlementSnapshot>;
      }
    ).anonymousSnapshotCappedToServedSizes();

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
