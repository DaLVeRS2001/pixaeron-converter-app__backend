import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';

@Injectable()
export class AnonymousIdentityService {
  private readonly ipHashSecret: string;

  constructor(configService: ConfigService) {
    this.ipHashSecret = configService.getOrThrow<string>('IP_HASH_SECRET');
  }

  subjectFor(ip: string): string {
    const hash = createHmac('sha256', this.ipHashSecret)
      .update(budgetKeyFor(ip))
      .digest('hex');

    return `anon:${hash}`;
  }
}

function budgetKeyFor(ip: string): string {
  if (isIPv4(ip)) return ip;

  const withoutZone = ip.split('%')[0];
  const lastColon = withoutZone.lastIndexOf(':');
  const embeddedIpv4 = withoutZone.slice(lastColon + 1);
  if (isIPv4(embeddedIpv4) && withoutZone.toLowerCase().startsWith('::ffff:')) {
    return embeddedIpv4;
  }

  if (!isIPv6(withoutZone)) return withoutZone;

  const [head, tail = ''] = withoutZone.split('::');
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const groups = [
    ...headGroups,
    ...Array.from(
      { length: Math.max(0, 8 - headGroups.length - tailGroups.length) },
      () => '0',
    ),
    ...tailGroups,
  ];

  return groups
    .slice(0, 4)
    .map((group) => group.padStart(4, '0').toLowerCase())
    .join(':');
}
