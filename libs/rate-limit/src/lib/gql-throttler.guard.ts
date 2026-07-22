import { ExecutionContext, Injectable } from '@nestjs/common';
import { GqlExecutionContext } from '@pixaeron/graphql';
import { HttpContext } from '@pixaeron/nestjs';
import { ThrottlerGuard } from '@nestjs/throttler';

@Injectable()
export class GqlThrottlerGuard extends ThrottlerGuard {
  protected getRequestResponse(context: ExecutionContext) {
    if (context.getType<string>() === 'graphql') {
      const gqlContext = GqlExecutionContext.create(context);
      const { req, res } = gqlContext.getContext<HttpContext>();

      return { req, res };
    }

    return super.getRequestResponse(context);
  }
}
