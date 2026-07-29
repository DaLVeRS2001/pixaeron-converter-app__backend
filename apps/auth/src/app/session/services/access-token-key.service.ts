import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  KeyObject,
} from 'node:crypto';

import {
  ACCESS_TOKEN_ALGORITHM,
  MINIMUM_RSA_MODULUS_BITS,
} from '../constants/access-token.constants';

type PublicJwk = Readonly<{
  alg: typeof ACCESS_TOKEN_ALGORITHM;
  e: string;
  kid: string;
  kty: 'RSA';
  n: string;
  use: 'sig';
}>;

type VerificationKey = {
  jwk: PublicJwk;
  publicKey: string;
};

@Injectable()
export class AccessTokenKeyService {
  private readonly activeKid: string;
  private readonly jwks: readonly PublicJwk[];
  private readonly signingKey: KeyObject;
  private readonly verificationKeys = new Map<string, string>();

  constructor(configService: ConfigService) {
    this.signingKey = this.readPrivateKey(
      configService.getOrThrow('JWT_PRIVATE_KEY_BASE64'),
    );

    const activeKey = this.createVerificationKey(
      createPublicKey(this.signingKey),
    );
    const previousKeyValue = configService.get<string>(
      'JWT_PREVIOUS_PUBLIC_KEY_BASE64',
    );
    const previousKey = previousKeyValue
      ? this.createVerificationKey(this.readPublicKey(previousKeyValue))
      : null;
    const keys =
      previousKey && previousKey.jwk.kid !== activeKey.jwk.kid
        ? [activeKey, previousKey]
        : [activeKey];

    this.activeKid = activeKey.jwk.kid;
    this.jwks = keys.map(({ jwk }) => jwk);

    for (const key of keys) {
      this.verificationKeys.set(key.jwk.kid, key.publicKey);
    }
  }

  getActiveKid(): string {
    return this.activeKid;
  }

  getSigningKey(): KeyObject {
    return this.signingKey;
  }

  getVerificationKey(kid: string): string | undefined {
    return this.verificationKeys.get(kid);
  }

  getJwks(): readonly PublicJwk[] {
    return this.jwks;
  }

  private readPrivateKey(value: string): KeyObject {
    let key: KeyObject;

    try {
      key = createPrivateKey({
        key: Buffer.from(value, 'base64'),
        format: 'der',
        type: 'pkcs8',
      });
    } catch {
      throw new Error(
        'JWT_PRIVATE_KEY_BASE64 must contain a PKCS#8 DER RSA private key',
      );
    }

    this.assertSupportedRsaKey(key, 'JWT_PRIVATE_KEY_BASE64');
    return key;
  }

  private readPublicKey(value: string): KeyObject {
    let key: KeyObject;

    try {
      key = createPublicKey({
        key: Buffer.from(value, 'base64'),
        format: 'der',
        type: 'spki',
      });
    } catch {
      throw new Error(
        'JWT_PREVIOUS_PUBLIC_KEY_BASE64 must contain an SPKI DER RSA public key',
      );
    }

    this.assertSupportedRsaKey(key, 'JWT_PREVIOUS_PUBLIC_KEY_BASE64');
    return key;
  }

  private assertSupportedRsaKey(key: KeyObject, variableName: string): void {
    if (
      key.asymmetricKeyType !== 'rsa' ||
      (key.asymmetricKeyDetails?.modulusLength ?? 0) < MINIMUM_RSA_MODULUS_BITS
    ) {
      throw new Error(
        `${variableName} must contain an RSA key of at least ${MINIMUM_RSA_MODULUS_BITS} bits`,
      );
    }
  }

  private createVerificationKey(publicKey: KeyObject): VerificationKey {
    const exported = publicKey.export({ format: 'jwk' });

    if (exported.kty !== 'RSA' || !exported.n || !exported.e) {
      throw new Error('Unable to export the JWT RSA public key');
    }

    const kid = createHash('sha256')
      .update(JSON.stringify({ e: exported.e, kty: 'RSA', n: exported.n }))
      .digest('base64url');

    return {
      jwk: {
        alg: ACCESS_TOKEN_ALGORITHM,
        e: exported.e,
        kid,
        kty: 'RSA',
        n: exported.n,
        use: 'sig',
      },
      publicKey: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    };
  }
}
