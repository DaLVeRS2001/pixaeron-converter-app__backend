export const TIER_QUEUES: Record<number, string> = {
  0: 'pixaeron-conversion-anon',
  1: 'pixaeron-conversion-free',
  2: 'pixaeron-conversion-light',
  3: 'pixaeron-conversion-pro',
};

export const PAID_LARGE_QUEUE = 'pixaeron-conversion-paid-large';

export const EVENTS_QUEUE = 'pixaeron-conversion-events';

export const queueUrl = (
  region: string,
  accountId: string,
  queue: string,
  suffix: string,
): string =>
  `https://sqs.${region}.amazonaws.com/${accountId}/${queue}${suffix}`;
