import { normalizeEmail } from '@pixaeron/config';
import { ConfigService } from '@nestjs/config';

import { RecipientHashService } from './recipient-hash.service';

const activeKey = Buffer.alloc(32, 1).toString('base64');
const previousKey = Buffer.alloc(32, 2).toString('base64');
const oldestKey = Buffer.alloc(32, 3).toString('base64');

describe('RecipientHashService', () => {
  const prisma = {
    emailDestination: { groupBy: jest.fn() },
    emailDelivery: { groupBy: jest.fn() },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.emailDestination.groupBy.mockResolvedValue([]);
    prisma.emailDelivery.groupBy.mockResolvedValue([]);
  });

  it('normalizes only surrounding whitespace and letter case', () => {
    expect(normalizeEmail('  User.Name+tag@Example.COM ')).toBe(
      'user.name+tag@example.com',
    );
  });

  it('creates a deterministic active hash without exposing the recipient', () => {
    const service = createService();

    const first = service.create('User@example.com');
    const second = service.create(' user@EXAMPLE.com ');

    expect(first).toEqual(second);
    expect(first.keyVersion).toBe(2);
    expect(first.value).toMatch(/^[a-f0-9]{64}$/);
    expect(first.value).not.toContain('user');
  });

  it('returns every retained hash key with the active key first', () => {
    const service = createService({
      RECIPIENT_HMAC_KEYRING_JSON: JSON.stringify({
        1: oldestKey,
        2: activeKey,
        3: previousKey,
      }),
      RECIPIENT_HMAC_ACTIVE_KEY_VERSION: '2',
    });

    const hashes = service.createLookupHashes('user@example.com');

    expect(hashes.map(({ keyVersion }) => keyVersion)).toEqual([2, 3, 1]);
    expect(new Set(hashes.map(({ value }) => value)).size).toBe(3);
  });

  it('starts when every retained database key version is configured', async () => {
    prisma.emailDestination.groupBy.mockResolvedValue([
      { recipientHashKeyVersion: 1 },
    ]);
    prisma.emailDelivery.groupBy.mockResolvedValue([
      { recipientHashKeyVersion: 2 },
    ]);
    const service = createService({
      RECIPIENT_HMAC_KEYRING_JSON: JSON.stringify({
        1: previousKey,
        2: activeKey,
      }),
    });

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(prisma.emailDestination.groupBy).toHaveBeenCalledWith({
      by: ['recipientHashKeyVersion'],
    });
    expect(prisma.emailDelivery.groupBy).toHaveBeenCalledWith({
      by: ['recipientHashKeyVersion'],
    });
  });

  it('refuses to start when a retained database key version is missing', async () => {
    prisma.emailDelivery.groupBy.mockResolvedValue([
      { recipientHashKeyVersion: 1 },
    ]);
    const service = createService();

    await expect(service.onApplicationBootstrap()).rejects.toThrow(
      'Recipient HMAC keyring is missing retained key versions: 1',
    );
  });

  function createService(extra: Record<string, unknown> = {}) {
    const values = {
      RECIPIENT_HMAC_KEYRING_JSON: JSON.stringify({ 2: activeKey }),
      RECIPIENT_HMAC_ACTIVE_KEY_VERSION: '2',
      ...extra,
    };

    return new RecipientHashService(
      new ConfigService<Record<string, unknown>>(values),
      prisma as never,
    );
  }
});
