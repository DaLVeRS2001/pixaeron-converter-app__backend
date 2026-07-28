import { AuthTokenType } from '../../../generated/prisma/client';
import { AuthTokenService } from './auth-token.service';

describe('AuthTokenService', () => {
  const transaction = {
    $executeRaw: jest.fn(),
    authToken: {
      create: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
  };
  const prisma = {
    authToken: {
      findFirst: jest.fn(),
    },
  };
  const service = new AuthTokenService(prisma as never);

  beforeEach(() => {
    jest.clearAllMocks();
    transaction.$executeRaw.mockResolvedValue(1);
    transaction.authToken.updateMany.mockResolvedValue({ count: 0 });
    transaction.authToken.create.mockResolvedValue({});
  });

  it('stores only a hash and consumes previous tokens while holding a database lock', async () => {
    const now = new Date('2026-07-27T12:00:00.000Z');
    const token = await service.issueInTransaction(
      transaction as never,
      42,
      AuthTokenType.PASSWORD_RESET,
      now,
    );
    const createCall = transaction.authToken.create.mock.calls[0]?.[0] as {
      data: { tokenHash: string; expiresAt: Date };
    };

    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(createCall.data.tokenHash).toBe(service.hash(token));
    expect(createCall.data.tokenHash).not.toContain(token);
    expect(createCall.data.expiresAt).toEqual(
      new Date('2026-07-27T12:15:00.000Z'),
    );
    expect(transaction.$executeRaw).toHaveBeenCalledTimes(1);
    expect(transaction.authToken.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 42,
        type: AuthTokenType.PASSWORD_RESET,
        consumedAt: null,
      },
      data: { consumedAt: now },
    });
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

  it('looks up a token through the caller transaction', async () => {
    transaction.authToken.findFirst.mockResolvedValue(null);

    await service.findInTransaction(
      transaction as never,
      'raw-token',
      AuthTokenType.EMAIL_VERIFICATION,
    );

    expect(transaction.authToken.findFirst).toHaveBeenCalledWith({
      where: {
        tokenHash: service.hash('raw-token'),
        type: AuthTokenType.EMAIL_VERIFICATION,
      },
      include: { user: true },
    });
    expect(prisma.authToken.findFirst).not.toHaveBeenCalled();
  });
});
