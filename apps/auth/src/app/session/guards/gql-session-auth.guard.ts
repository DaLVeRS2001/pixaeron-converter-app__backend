import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@pixaeron/graphql';
import { HttpContext } from '@pixaeron/nestjs';

import { AuthenticatedUser } from '../../user/prisma/user.select';
import { SessionService } from '../services/session.service';

@Injectable()
export class GqlSessionAuthGuard implements CanActivate {
  constructor(private readonly sessionService: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const ctx = GqlExecutionContext.create(context);
    const gqlContext = ctx.getContext<HttpContext>();
    const user = await this.sessionService.authenticateRequest(
      gqlContext.req,
      gqlContext.res,
    );

    (gqlContext.req as HttpContext['req'] & { user: AuthenticatedUser }).user =
      user;

    return true;
  }
}
