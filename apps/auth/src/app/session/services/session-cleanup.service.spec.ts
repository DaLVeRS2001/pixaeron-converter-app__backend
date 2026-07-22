import { SessionCleanupService } from './session-cleanup.service';

describe('SessionCleanupService', () => {
  const prisma = {
    session: { deleteMany: jest.fn() },
    sessionEvent: { deleteMany: jest.fn() },
  };
  const redisLockService = {
    acquire: jest.fn(),
    release: jest.fn(),
  };
  const service = new SessionCleanupService(
    prisma as never,
    redisLockService as never,
  );

  beforeEach(() => jest.clearAllMocks());

  it('does nothing when another replica owns the cleanup lock', async () => {
    redisLockService.acquire.mockResolvedValue(null);

    await service.deleteExpiredAuthSessionsAndEvents();

    expect(prisma.session.deleteMany).not.toHaveBeenCalled();
    expect(prisma.sessionEvent.deleteMany).not.toHaveBeenCalled();
    expect(redisLockService.release).not.toHaveBeenCalled();
  });

  it('deletes expired data and releases its lock', async () => {
    redisLockService.acquire.mockResolvedValue('owner-token');

    await service.deleteExpiredAuthSessionsAndEvents();

    expect(prisma.session.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.sessionEvent.deleteMany).toHaveBeenCalledTimes(1);
    expect(redisLockService.release).toHaveBeenCalledWith(
      'session-cleanup',
      'owner-token',
    );
  });

  it('releases its lock when cleanup fails', async () => {
    redisLockService.acquire.mockResolvedValue('owner-token');
    prisma.session.deleteMany.mockRejectedValue(
      new Error('database unavailable'),
    );

    await expect(service.deleteExpiredAuthSessionsAndEvents()).rejects.toThrow(
      'database unavailable',
    );
    expect(redisLockService.release).toHaveBeenCalledWith(
      'session-cleanup',
      'owner-token',
    );
  });
});
