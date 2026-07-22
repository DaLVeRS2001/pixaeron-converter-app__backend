import { UseGuards } from '@nestjs/common';
import { Args, Context, Mutation, Resolver } from '@pixaeron/graphql';
import { HttpContext } from '@pixaeron/nestjs';

import { User } from '../user/models/user.model';
import { AuthenticatedUser } from '../user/prisma/user.select';
import { AuthService } from './auth.service';
import { GoogleLoginInput } from './dto/google-login.input';
import { LoginInput } from './dto/login.input';
import { RegisterInput } from './dto/register.input';
import { GqlAuthGuard } from './guards/gql-auth.guard';
import { Throttle } from '@nestjs/throttler';
import { AUTH_RATE_LIMIT } from '../rate-limit/rate-limit.constants';

@Resolver()
export class AuthResolver {
  constructor(private readonly authService: AuthService) {}

  @Mutation(() => User)
  @Throttle(AUTH_RATE_LIMIT)
  async login(
    @Args('loginInput') loginInput: LoginInput,
    @Context() context: HttpContext,
  ) {
    return this.authService.login(loginInput, context.req, context.res);
  }

  @Mutation(() => User)
  @Throttle(AUTH_RATE_LIMIT)
  async register(
    @Args('registerInput') registerInput: RegisterInput,
    @Context() context: HttpContext,
  ) {
    return this.authService.register(registerInput, context.req, context.res);
  }

  @Mutation(() => User)
  @Throttle(AUTH_RATE_LIMIT)
  async googleLogin(
    @Args('googleLoginInput') googleLoginInput: GoogleLoginInput,
    @Context() context: HttpContext,
  ) {
    return this.authService.googleLogin(
      googleLoginInput,
      context.req,
      context.res,
    );
  }

  @Mutation(() => Boolean)
  async logout(@Context() context: HttpContext) {
    return this.authService.logout(context.req, context.res);
  }

  @UseGuards(GqlAuthGuard)
  @Mutation(() => Boolean)
  async logoutAll(
    @Context('req') request: HttpContext['req'] & { user: AuthenticatedUser },
    @Context('res') response: HttpContext['res'],
  ) {
    return this.authService.logoutAll(request.user.id, request, response);
  }
}
