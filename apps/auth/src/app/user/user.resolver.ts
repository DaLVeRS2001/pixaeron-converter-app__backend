import { Context, Query, Resolver } from '@pixaeron/graphql';
import { User } from './models/user.model';
import { HttpContext } from '@pixaeron/nestjs';
import { UseGuards } from '@nestjs/common';
import { GqlSessionAuthGuard } from '../session/guards/gql-session-auth.guard';
import { AuthenticatedUser } from './prisma/user.select';

@Resolver(() => User)
export class UserResolver {
  @UseGuards(GqlSessionAuthGuard)
  @Query(() => User)
  async me(
    @Context('req') request: HttpContext['req'] & { user: AuthenticatedUser },
  ) {
    return request.user;
  }
}
