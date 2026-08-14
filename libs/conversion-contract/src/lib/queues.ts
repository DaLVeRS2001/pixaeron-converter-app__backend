const TIER_QUEUES = [
  'pixaeron-conversion-anon',
  'pixaeron-conversion-free',
  'pixaeron-conversion-light',
  'pixaeron-conversion-pro',
];

export const PAID_LARGE_QUEUE = 'pixaeron-conversion-paid-large';

export const EVENTS_QUEUE = 'pixaeron-conversion-events';

export const queueForTier = (tier: number): string => {
  const queue = TIER_QUEUES[tier];
  if (!queue) throw new Error(`Unmapped queue tier ${tier}`);

  return queue;
};

export const queueUrl = (
  region: string,
  accountId: string,
  queue: string,
  suffix: string,
): string =>
  `https://sqs.${region}.amazonaws.com/${accountId}/${queue}${suffix}`;
