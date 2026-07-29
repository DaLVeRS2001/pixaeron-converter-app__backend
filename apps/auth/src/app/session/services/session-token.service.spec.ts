import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync } from 'node:crypto';

import {
  ACCESS_TOKEN_ALGORITHM,
  ACCESS_TOKEN_TYPE,
} from '../constants/access-token.constants';
import { AccessTokenKeyService } from './access-token-key.service';
import { SessionTokenService } from './session-token.service';

function createRsaKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  return {
    privateKey,
    privateKeyBase64: privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64'),
    publicKeyBase64: publicKey
      .export({ format: 'der', type: 'spki' })
      .toString('base64'),
  };
}

const issuer = 'https://api.pixaeron.com/auth';
const audience = 'pixaeron-api';
const subject = '0198f687-15d8-7f5e-bd79-62f8f4d51e07';
const active = createRsaKeyPair();
const previous = createRsaKeyPair();
const jwtService = new JwtService();
const configService = new ConfigService({
  JWT_PRIVATE_KEY_BASE64: active.privateKeyBase64,
  JWT_PREVIOUS_PUBLIC_KEY_BASE64: previous.publicKeyBase64,
  JWT_ISSUER: issuer,
  JWT_AUDIENCE: audience,
  JWT_EXPIRATION_MS: '900000',
  REFRESH_TOKEN_HASH_ROUNDS: '12',
  REFRESH_EXPIRATION_MS: '604800000',
  SESSION_REFRESH_EXPIRATION_MS: '86400000',
});
const keys = new AccessTokenKeyService(configService);
const service = new SessionTokenService(configService, jwtService, keys);

function signWithActive(options: {
  audience?: string;
  expiresIn?: number;
  issuer?: string;
  kid?: string;
  noTimestamp?: boolean;
  subject?: string;
  type?: string;
}) {
  return jwtService.sign(
    {},
    {
      algorithm: ACCESS_TOKEN_ALGORITHM,
      audience: options.audience ?? audience,
      ...(options.expiresIn === undefined
        ? {}
        : { expiresIn: options.expiresIn }),
      header: {
        alg: ACCESS_TOKEN_ALGORITHM,
        kid: options.kid ?? keys.getActiveKid(),
        typ: options.type ?? ACCESS_TOKEN_TYPE,
      },
      issuer: options.issuer ?? issuer,
      ...(options.noTimestamp === undefined
        ? {}
        : { noTimestamp: options.noTimestamp }),
      privateKey: active.privateKey,
      ...(options.subject === undefined ? {} : { subject: options.subject }),
    },
  );
}

describe('SessionTokenService refresh tokens', () => {
  it('parses legacy and tracked refresh credentials', () => {
    expect(service.parseRefreshToken('session.secret')).toEqual({
      sessionId: 'session',
      refreshCredential: 'secret',
    });
    expect(service.parseRefreshToken('session.token.secret')).toEqual({
      sessionId: 'session',
      tokenId: 'token',
      refreshCredential: 'token.secret',
    });
  });

  it.each([
    undefined,
    '',
    '.secret',
    'session.',
    'session.token.',
    'too.many.parts.here',
  ])('rejects malformed refresh token %p', (token) => {
    expect(service.parseRefreshToken(token)).toBeNull();
  });
});

describe('SessionTokenService access tokens', () => {
  it('issues and verifies the Pixaeron access-token profile', async () => {
    const token = service.signAccessToken(subject);
    const decoded = jwtService.decode<{
      header: Record<string, unknown>;
      payload: Record<string, unknown>;
    }>(token, { complete: true });

    expect(decoded.header).toMatchObject({
      alg: ACCESS_TOKEN_ALGORITHM,
      kid: keys.getActiveKid(),
      typ: ACCESS_TOKEN_TYPE,
    });
    expect(decoded.payload).toMatchObject({
      aud: audience,
      iss: issuer,
      sub: subject,
    });
    expect(decoded.payload).not.toHaveProperty('userId');
    await expect(service.verifyAccessToken(token)).resolves.toEqual({
      subject,
    });
  });

  it('accepts a correctly profiled token signed by the previous key', async () => {
    const previousJwk = keys
      .getJwks()
      .find(({ kid }) => kid !== keys.getActiveKid());
    const token = jwtService.sign(
      {},
      {
        algorithm: ACCESS_TOKEN_ALGORITHM,
        audience,
        expiresIn: 900,
        header: {
          alg: ACCESS_TOKEN_ALGORITHM,
          kid: previousJwk?.kid ?? '',
          typ: ACCESS_TOKEN_TYPE,
        },
        issuer,
        privateKey: previous.privateKey,
        subject,
      },
    );

    await expect(service.verifyAccessToken(token)).resolves.toEqual({
      subject,
    });
  });

  it('rejects tokens outside the exact access-token profile', async () => {
    const hmacToken = jwtService.sign(
      {},
      {
        algorithm: 'HS256',
        audience,
        expiresIn: 900,
        header: {
          alg: 'HS256',
          kid: keys.getActiveKid(),
          typ: ACCESS_TOKEN_TYPE,
        },
        issuer,
        secret: 'test-only-symmetric-secret-at-least-32-characters',
        subject,
      },
    );
    const invalidTokens = [
      'not-a-jwt',
      hmacToken,
      signWithActive({ expiresIn: 900, subject, type: 'JWT' }),
      signWithActive({ audience: 'another-api', expiresIn: 900, subject }),
      signWithActive({
        expiresIn: 900,
        issuer: 'https://attacker.example/auth',
        subject,
      }),
      signWithActive({ expiresIn: 900, kid: 'unknown', subject }),
      signWithActive({ expiresIn: 900, noTimestamp: true, subject }),
      signWithActive({ expiresIn: 900 }),
    ];

    await Promise.all(
      invalidTokens.map(async (token) =>
        expect(service.verifyAccessToken(token)).resolves.toBeNull(),
      ),
    );
  });
});
