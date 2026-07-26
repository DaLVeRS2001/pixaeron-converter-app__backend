import { UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Args, Context, Mutation, Resolver } from '@pixaeron/graphql';
import { HttpContext } from '@pixaeron/nestjs';

import { AUTH_RATE_LIMIT } from '../rate-limit/rate-limit.constants';
import { AuthenticatedUser } from '../user/prisma/user.select';
import { AuthService } from './auth.service';
import { AuthTokenInput } from './dto/auth-token.input';
import { EmailActionInput } from './dto/email-action.input';
import { GoogleLoginInput } from './dto/google-login.input';
import { LoginInput } from './dto/login.input';
import { RegisterInput } from './dto/register.input';
import { ResetPasswordInput } from './dto/reset-password.input';
import { GqlAuthGuard } from './guards/gql-auth.guard';
import {
  AuthRequestResult,
  EmailVerificationResult,
  PasswordResetResult,
  RegistrationResult,
} from './models/auth-result.model';
import { User } from '../user/models/user.model';

@Resolver()
export class AuthResolver {
  constructor(private readonly authService: AuthService) {}

  @Mutation(() => User)
  @Throttle(AUTH_RATE_LIMIT)
  login(
    @Args('loginInput') loginInput: LoginInput,
    @Context() context: HttpContext,
  ) {
    return this.authService.login(loginInput, context.req, context.res);
  }

  @Mutation(() => RegistrationResult)
  @Throttle(AUTH_RATE_LIMIT)
  register(
    @Args('registerInput') registerInput: RegisterInput,
    @Context('req') request: HttpContext['req'],
  ) {
    return this.authService.register(registerInput, request);
  }

  @Mutation(() => AuthRequestResult)
  @Throttle(AUTH_RATE_LIMIT)
  resendEmailVerification(
    @Args('input') input: EmailActionInput,
    @Context('req') request: HttpContext['req'],
  ) {
    return this.authService.resendEmailVerification(input, request);
  }

  @Mutation(() => EmailVerificationResult)
  @Throttle(AUTH_RATE_LIMIT)
  verifyEmail(
    @Args('input') input: AuthTokenInput,
    @Context('req') request: HttpContext['req'],
  ) {
    return this.authService.verifyEmail(input, request);
  }

  @Mutation(() => AuthRequestResult)
  @Throttle(AUTH_RATE_LIMIT)
  requestPasswordReset(
    @Args('input') input: EmailActionInput,
    @Context('req') request: HttpContext['req'],
  ) {
    return this.authService.requestPasswordReset(input, request);
  }

  @Mutation(() => PasswordResetResult)
  @Throttle(AUTH_RATE_LIMIT)
  resetPassword(
    @Args('input') input: ResetPasswordInput,
    @Context() context: HttpContext,
  ) {
    return this.authService.resetPassword(input, context.req, context.res);
  }

  @Mutation(() => User)
  @Throttle(AUTH_RATE_LIMIT)
  googleLogin(
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
  logout(@Context() context: HttpContext) {
    return this.authService.logout(context.req, context.res);
  }

  @UseGuards(GqlAuthGuard)
  @Mutation(() => Boolean)
  logoutAll(
    @Context('req') request: HttpContext['req'] & { user: AuthenticatedUser },
    @Context('res') response: HttpContext['res'],
  ) {
    return this.authService.logoutAll(request.user.id, request, response);
  }
}
