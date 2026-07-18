import { ExecutionContext } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { GqlExecutionContext } from '@pixaeron/graphql';
import { HttpContext } from '@pixaeron/nestjs';

export class GqlAuthGuard extends AuthGuard('jwt') {
  getRequest(context: ExecutionContext): HttpContext['req'] {
    const ctx = GqlExecutionContext.create(context);
    return ctx.getContext().req;
  }
}
