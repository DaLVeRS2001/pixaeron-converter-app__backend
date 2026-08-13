import type { ConfigService } from '@nestjs/config';

import { AnonymousIdentityService } from './anonymous-identity.service';

const service = new AnonymousIdentityService({
  getOrThrow: () => 'identity-secret-that-is-32-chars-long',
} as unknown as ConfigService);

describe('AnonymousIdentityService', () => {
  it('derives a stable anon subject from an IPv4 address', () => {
    const subject = service.subjectFor('203.0.113.10');

    expect(subject).toMatch(/^anon:[0-9a-f]{64}$/);
    expect(service.subjectFor('203.0.113.10')).toBe(subject);
    expect(service.subjectFor('203.0.113.11')).not.toBe(subject);
  });

  it('treats an IPv4-mapped IPv6 address as its embedded IPv4', () => {
    expect(service.subjectFor('::ffff:203.0.113.10')).toBe(
      service.subjectFor('203.0.113.10'),
    );
    expect(service.subjectFor('::ffff:203.0.113.10')).not.toBe(
      service.subjectFor('::ffff:198.51.100.7'),
    );
  });

  it('shares one budget across an IPv6 /64 and separates different prefixes', () => {
    const first = service.subjectFor('2001:db8:1:1::1');
    const rotated = service.subjectFor('2001:db8:1:1:ffff:ffff:ffff:fffe');
    const otherPrefix = service.subjectFor('2001:db8:1:2::1');

    expect(rotated).toBe(first);
    expect(otherPrefix).not.toBe(first);
  });

  it('normalizes compressed and expanded IPv6 spellings', () => {
    expect(service.subjectFor('2001:0db8:0001:0001:0:0:0:1')).toBe(
      service.subjectFor('2001:db8:1:1::1'),
    );
  });

  it('keeps loopback and unparseable inputs in their own buckets', () => {
    expect(service.subjectFor('::1')).not.toBe(
      service.subjectFor('::ffff:203.0.113.10'),
    );
    expect(service.subjectFor('garbage')).toBe(service.subjectFor('garbage'));
    expect(service.subjectFor('garbage')).not.toBe(service.subjectFor('::1'));
  });
});
