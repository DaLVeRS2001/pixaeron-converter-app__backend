import { AuthTokenType } from '../../generated/prisma/client';
import { AuthTokenService } from './auth-token.service';

describe('AuthTokenService', () => {
  const transaction = {
    $executeRaw: jest.fn(),
    authToken: {
      create: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const prisma = {
    authToken: {
      findFirst: jest.fn(),
    },
    $transaction: jest.fn(),
  };
  const service = new AuthTokenService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
    transaction.$executeRaw.mockResolvedValue(1);
    transaction.authToken.updateMany.mockResolvedValue({ count: 0 });
    transaction.authToken.create.mockResolvedValue({});
    prisma.$transaction.mockImplementation((callback) => callback(transaction));
  });

  it('stores only a hash and consumes previous tokens while holding a database lock', async () => {
    const token = await service.issue(42, AuthTokenType.EMAIL_VERIFICATION);
    const createCall = transaction.authToken.create.mock.calls[0]?.[0] as {
      data: { tokenHash: string; expiresAt: Date };
    };

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createCall.data.tokenHash).toBe(service.hash(token));
    expect(createCall.data.tokenHash).not.toContain(token);
    expect(createCall.data.expiresAt).toBeInstanceOf(Date);
    expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
    expect(transaction.authToken.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 42,
        type: AuthTokenType.EMAIL_VERIFICATION,
        consumedAt: null,
      },
      data: { consumedAt: expect.any(Date) },
    });
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function));
  });

  it('serializes concurrent issuance for the same user and token type', async () => {
    let lockHeld = false;
    const lockWaiters: Array<() => void> = [];
    let activeCriticalSections = 0;
    let maxActiveCriticalSections = 0;

    transaction.$executeRaw.mockImplementation(async () => {
      if (lockHeld) {
        await new Promise<void>((resolve) => lockWaiters.push(resolve));
      }
      lockHeld = true;
      activeCriticalSections += 1;
      maxActiveCriticalSections = Math.max(
        maxActiveCriticalSections,
        activeCriticalSections,
      );
    });
    prisma.$transaction.mockImplementation(async (callback) => {
      try {
        return await callback(transaction);
      } finally {
        activeCriticalSections -= 1;
        lockHeld = false;
        lockWaiters.shift()?.();
      }
    });

    await Promise.all([
      service.issue(42, AuthTokenType.PASSWORD_RESET),
      service.issue(42, AuthTokenType.PASSWORD_RESET),
    ]);

    expect(maxActiveCriticalSections).toBe(1);
    expect(transaction.authToken.create).toHaveBeenCalledTimes(2);
  });

  it('looks up a token by type and SHA-256 hash', async () => {
    prisma.authToken.findFirst.mockResolvedValue(null);

    await service.find('raw-token', AuthTokenType.PASSWORD_RESET);

    expect(prisma.authToken.findFirst).toHaveBeenCalledWith({
      where: {
        tokenHash: service.hash('raw-token'),
        type: AuthTokenType.PASSWORD_RESET,
      },
      include: { user: true },
    });
  });
});
