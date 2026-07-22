import { RedisLockService } from './redis-lock.service';

describe('RedisLockService', () => {
  const redis = {
    set: jest.fn(),
    eval: jest.fn(),
  };
  const service = new RedisLockService(redis as never);

  beforeEach(() => jest.clearAllMocks());

  it('returns an ownership token only when Redis creates the lock', async () => {
    redis.set.mockResolvedValueOnce('OK').mockResolvedValueOnce(null);

    const token = await service.acquire('cleanup', 60_000);

    expect(token).toEqual(expect.any(String));
    expect(redis.set).toHaveBeenCalledWith('lock:cleanup', token, {
      NX: true,
      PX: 60_000,
    });
    await expect(service.acquire('cleanup', 60_000)).resolves.toBeNull();
  });

  it('releases a lock through a compare-and-delete script', async () => {
    await service.release('cleanup', 'owner-token');

    expect(redis.eval).toHaveBeenCalledWith(expect.any(String), {
      keys: ['lock:cleanup'],
      arguments: ['owner-token'],
    });
  });
});
