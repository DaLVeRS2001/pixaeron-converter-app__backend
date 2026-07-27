import { UserService } from './user.service';

describe('UserService', () => {
  const prisma = {
    user: {
      findUnique: jest.fn(),
    },
  };
  const transaction = {
    user: {
      create: jest.fn(),
    },
  };
  const configService = {
    getOrThrow: jest.fn().mockReturnValue('4'),
  };
  const service = new UserService(prisma as never, configService as never);

  beforeEach(() => {
    jest.clearAllMocks();
    transaction.user.create.mockResolvedValue({ id: 1 });
  });

  it('creates a local user through the caller transaction', async () => {
    const acceptedAt = new Date('2026-07-27T12:00:00.000Z');

    await service.createLocalUserInTransaction(transaction as never, {
      email: 'user@example.com',
      username: 'user',
      passwordHash: 'precomputed-password-hash',
      legalConsentVersion: '2026-07-26',
      legalConsentAcceptedAt: acceptedAt,
    });

    expect(transaction.user.create).toHaveBeenCalledWith({
      data: {
        email: 'user@example.com',
        username: 'user',
        password: 'precomputed-password-hash',
        legalConsentVersion: '2026-07-26',
        legalConsentAcceptedAt: acceptedAt,
      },
    });
  });

  it('hashes and verifies a password with the configured work factor', async () => {
    const passwordHash = await service.hashPassword('correct-password');

    await expect(
      service.verifyPassword('correct-password', passwordHash),
    ).resolves.toBe(true);
    await expect(
      service.verifyPassword('wrong-password', passwordHash),
    ).resolves.toBe(false);
  });

  it('still runs bcrypt when an account has no password', async () => {
    await expect(
      service.verifyPassword('any-password', undefined),
    ).resolves.toBe(false);
  });
});
