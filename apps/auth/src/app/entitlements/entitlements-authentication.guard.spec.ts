import { Metadata } from '@grpc/grpc-js';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';

import {
  COMMAND_SECRET_METADATA_KEY,
  EntitlementsAuthenticationGuard,
} from './entitlements-authentication.guard';

const SECRET = 'entitlements-secret-that-is-32-chars-long';

const createGuard = (secret?: string) =>
  new EntitlementsAuthenticationGuard({
    get: jest.fn().mockReturnValue(secret),
  } as unknown as ConfigService);

const contextWith = (metadata: Metadata) =>
  ({
    switchToRpc: () => ({ getContext: () => metadata }),
  }) as unknown as ExecutionContext;

describe('EntitlementsAuthenticationGuard', () => {
  it('allows every call while no secret is configured', () => {
    expect(createGuard().canActivate(contextWith(new Metadata()))).toBe(true);
  });

  it('allows a call presenting the configured secret', () => {
    const metadata = new Metadata();
    metadata.add(COMMAND_SECRET_METADATA_KEY, SECRET);

    expect(createGuard(SECRET).canActivate(contextWith(metadata))).toBe(true);
  });

  it('rejects a call without the secret', () => {
    expect(() =>
      createGuard(SECRET).canActivate(contextWith(new Metadata())),
    ).toThrow(RpcException);
  });

  it('rejects a call presenting a different secret', () => {
    const metadata = new Metadata();
    metadata.add(COMMAND_SECRET_METADATA_KEY, `${SECRET}-wrong`);

    expect(() =>
      createGuard(SECRET).canActivate(contextWith(metadata)),
    ).toThrow(RpcException);
  });
});
