import { RedisCacheService } from './redis-cache.service';

describe('RedisCacheService', () => {
  const redis = {
    get: jest.fn(),
    set: jest.fn(),
    del: jest.fn(),
  };
  const service = new RedisCacheService(redis as never, 'auth');

  beforeEach(() => jest.clearAllMocks());

  it('returns parsed cached data', async () => {
    redis.get.mockResolvedValue(JSON.stringify({ code: 'free' }));

    await expect(service.get('plans')).resolves.toEqual({ code: 'free' });
    expect(redis.get).toHaveBeenCalledWith('auth:cache:plans');
  });

  it('returns null for a cache miss', async () => {
    redis.get.mockResolvedValue(null);

    await expect(service.get('plans')).resolves.toBeNull();
  });

  it('stores JSON with an expiration and deletes by namespace', async () => {
    await service.set('plans', [{ code: 'free' }], 300);
    await service.delete('plans');

    expect(redis.set).toHaveBeenCalledWith(
      'auth:cache:plans',
      JSON.stringify([{ code: 'free' }]),
      { EX: 300 },
    );
    expect(redis.del).toHaveBeenCalledWith('auth:cache:plans');
  });
});
