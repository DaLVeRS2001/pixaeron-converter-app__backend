import { Context, Query, Resolver } from '@pixaeron/graphql';
import { User } from './models/user.model';
import { HttpContext } from '@pixaeron/nestjs';
import { UseGuards } from '@nestjs/common';
import { GqlAuthGuard } from '../auth/guards/gql-auth.guard';

@Resolver(() => User)
export class UserResolver {
  @UseGuards(GqlAuthGuard)
  @Query(() => User)
  async me(@Context('req') request: HttpContext['req'] & { user: User }) {
    return request.user;
  }
}
