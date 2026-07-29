import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync } from 'node:crypto';

import { AccessTokenKeyService } from './access-token-key.service';

function createRsaKeyPair(modulusLength = 2048) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength,
  });

  return {
    privateKey: privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    publicKey: publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64'),
  };
}

const active = createRsaKeyPair();
const previous = createRsaKeyPair();

function createService(overrides: Record<string, string> = {}) {
  return new AccessTokenKeyService(
    new ConfigService({
      JWT_PRIVATE_KEY_BASE64: active.privateKey,
      ...overrides,
    }),
  );
}

describe('AccessTokenKeyService', () => {
  it('derives a stable public JWKS entry from the private signing key', () => {
    const service = createService();
    const [jwk] = service.getJwks();

    expect(jwk).toMatchObject({
      alg: 'RS256',
      kid: service.getActiveKid(),
      kty: 'RSA',
      use: 'sig',
    });
    expect(jwk.n).toBeTruthy();
    expect(jwk.e).toBeTruthy();
    expect(jwk).not.toHaveProperty('d');
    expect(service.getVerificationKey(jwk.kid)).toContain('BEGIN PUBLIC KEY');
  });

  it('publishes one previous verification key during rotation', () => {
    const service = createService({
      JWT_PREVIOUS_PUBLIC_KEY_BASE64: previous.publicKey,
    });

    expect(service.getJwks()).toHaveLength(2);
    expect(new Set(service.getJwks().map(({ kid }) => kid)).size).toBe(2);
  });

  it('rejects weak RSA signing keys', () => {
    expect(
      () =>
        new AccessTokenKeyService(
          new ConfigService({
            JWT_PRIVATE_KEY_BASE64: createRsaKeyPair(1024).privateKey,
          }),
        ),
    ).toThrow('at least 2048 bits');
  });

  it('rejects non-RSA signing keys', () => {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });

    expect(
      () =>
        new AccessTokenKeyService(
          new ConfigService({
            JWT_PRIVATE_KEY_BASE64: privateKey
              .export({ format: 'der', type: 'pkcs8' })
              .toString('base64'),
          }),
        ),
    ).toThrow('RSA key');
  });
});
