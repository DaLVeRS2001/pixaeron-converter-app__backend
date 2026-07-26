import { UnauthorizedException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';

import { GoogleAuthService } from './google-auth.service';

describe('GoogleAuthService', () => {
  const configService = {
    getOrThrow: jest.fn().mockReturnValue('google-client-id'),
  };
  const service = new GoogleAuthService(configService as never);

  afterEach(() => jest.restoreAllMocks());

  it('maps expired, malformed, and wrong-audience provider failures to a stable public error', async () => {
    jest
      .spyOn(OAuth2Client.prototype, 'verifyIdToken')
      .mockRejectedValue(
        new Error('Wrong recipient, payload details') as never,
      );

    const result = service.verifyIdToken('invalid-google-token');

    await expect(result).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(result).rejects.toMatchObject({
      response: {
        code: 'GOOGLE_TOKEN_INVALID',
        message: 'Google sign-in token is invalid or expired',
      },
    });
  });

  it('maps an incomplete verified payload to the same public error', async () => {
    jest.spyOn(OAuth2Client.prototype, 'verifyIdToken').mockResolvedValue({
      getPayload: () => ({ sub: 'google-sub-without-email' }),
    } as never);

    await expect(
      service.verifyIdToken('incomplete-token'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'GOOGLE_TOKEN_INVALID' }),
    });
  });
});
