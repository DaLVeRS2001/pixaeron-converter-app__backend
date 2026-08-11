import { Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';

import { PrismaService } from '../prisma/prisma.service';

export type RecipientHash = {
  value: string;
  keyVersion: number;
};

type RecipientHashKey = {
  value: Buffer;
  version: number;
};

export function normalizeRecipient(recipient: string): string {
  return recipient.trim().toLowerCase();
}

type RecipientHashWhere = {
  recipientHash: string;
  recipientHashKeyVersion: number;
};

export function recipientHashFilter(
  hashes: RecipientHash[],
): RecipientHashWhere[] {
  return hashes.map(({ value, keyVersion }) => ({
    recipientHash: value,
    recipientHashKeyVersion: keyVersion,
  }));
}

export function matchesRecipientHash(
  record: RecipientHashWhere,
  hashes: RecipientHash[],
): boolean {
  return hashes.some(
    ({ value, keyVersion }) =>
      record.recipientHash === value &&
      record.recipientHashKeyVersion === keyVersion,
  );
}

@Injectable()
export class RecipientHashService implements OnApplicationBootstrap {
  private readonly activeKey: RecipientHashKey;
  private readonly lookupKeys: RecipientHashKey[];

  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    const keyring = JSON.parse(
      configService.getOrThrow<string>('RECIPIENT_HMAC_KEYRING_JSON'),
    ) as Record<string, string>;
    const keys = Object.entries(keyring).map(([version, value]) => ({
      value: Buffer.from(value, 'base64'),
      version: Number(version),
    }));
    const activeVersion = Number(
      configService.getOrThrow<string>('RECIPIENT_HMAC_ACTIVE_KEY_VERSION'),
    );
    const activeKey = keys.find(({ version }) => version === activeVersion);

    if (!activeKey) {
      throw new Error('Recipient HMAC active key version is not configured');
    }

    this.activeKey = activeKey;
    this.lookupKeys = [
      activeKey,
      ...keys
        .filter(({ version }) => version !== activeVersion)
        .sort((left, right) => right.version - left.version),
    ];
  }

  async onApplicationBootstrap(): Promise<void> {
    const [destinations, deliveries] = await Promise.all([
      this.prisma.emailDestination.groupBy({
        by: ['recipientHashKeyVersion'],
      }),
      this.prisma.emailDelivery.groupBy({
        by: ['recipientHashKeyVersion'],
      }),
    ]);
    const configuredVersions = new Set(
      this.lookupKeys.map(({ version }) => version),
    );
    const retainedVersions = new Set(
      [...destinations, ...deliveries].map(
        ({ recipientHashKeyVersion }) => recipientHashKeyVersion,
      ),
    );
    const missingVersions = [...retainedVersions]
      .filter((version) => !configuredVersions.has(version))
      .sort((left, right) => left - right);

    if (missingVersions.length > 0) {
      throw new Error(
        'Recipient HMAC keyring is missing retained key versions: ' +
          missingVersions.join(', '),
      );
    }
  }

  create(recipient: string): RecipientHash {
    return this.hash(normalizeRecipient(recipient), this.activeKey);
  }

  createLookupHashes(recipient: string): RecipientHash[] {
    const normalizedRecipient = normalizeRecipient(recipient);
    return this.lookupKeys.map((key) => this.hash(normalizedRecipient, key));
  }

  private hash(recipient: string, key: RecipientHashKey): RecipientHash {
    return {
      value: createHmac('sha256', key.value).update(recipient).digest('hex'),
      keyVersion: key.version,
    };
  }
}
