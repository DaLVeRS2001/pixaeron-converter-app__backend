import type { ExecutionContext } from '@nestjs/common';
import { GqlExecutionContext } from '@pixaeron/graphql';

import { GqlSessionAuthGuard } from './gql-session-auth.guard';

const user = {
  id: 1,
  publicId: '0198f687-15d8-7f5e-bd79-62f8f4d51e07',
  email: 'user@example.com',
  username: 'User',
  emailVerified: true,
  planCode: 'FREE',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('GqlSessionAuthGuard', () => {
  it('authenticates only with the access token and attaches the user', async () => {
    const request = {};
    const sessionService = {
      authenticateAccessToken: jest.fn().mockResolvedValue(user),
    };
    jest.spyOn(GqlExecutionContext, 'create').mockReturnValue({
      getContext: () => ({ req: request }),
    } as never);
    const guard = new GqlSessionAuthGuard(sessionService as never);

    await expect(guard.canActivate({} as ExecutionContext)).resolves.toBe(true);

    expect(sessionService.authenticateAccessToken).toHaveBeenCalledWith(
      request,
    );
    expect(request).toEqual({ user });
  });
});
