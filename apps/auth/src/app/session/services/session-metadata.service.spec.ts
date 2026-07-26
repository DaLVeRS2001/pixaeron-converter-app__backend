import type { Request } from 'express';

import { SessionMetadataService } from './session-metadata.service';

describe('SessionMetadataService', () => {
  const configService = {
    getOrThrow: jest.fn().mockReturnValue('ip-hmac-secret'),
  };
  const service = new SessionMetadataService(configService as never);

  it('caps user-agent data before storing it in sessions or audit events', () => {
    const request = {
      ip: '203.0.113.1',
      headers: { 'user-agent': 'a'.repeat(2_000) },
      socket: {},
    } as unknown as Request;

    const metadata = service.getFromRequest(request);

    expect(metadata.userAgent).toHaveLength(512);
    expect(metadata.userAgent).toBe('a'.repeat(512));
  });

  it('keeps a missing user agent as null', () => {
    const request = {
      ip: '203.0.113.1',
      headers: {},
      socket: {},
    } as unknown as Request;

    expect(service.getFromRequest(request).userAgent).toBeNull();
  });
});
