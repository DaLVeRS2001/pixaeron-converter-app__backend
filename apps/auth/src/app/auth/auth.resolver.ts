import { UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Args, Context, Mutation, Resolver } from '@pixaeron/graphql';
import { HttpContext } from '@pixaeron/nestjs';

import { AUTH_RATE_LIMIT } from './constants/rate-limit.constants';
import { GqlSessionAuthGuard } from '../session/guards/gql-session-auth.guard';
import { SessionService } from '../session/services/session.service';
import { User } from '../user/models/user.model';
import { AuthenticatedUser } from '../user/prisma/user.select';
import { AuthTokenInput } from './dto/auth-token.input';
import { EmailActionInput } from './dto/email-action.input';
import { LoginInput } from './password/login.input';
import { RegisterInput } from './registration/register.input';
import { ResetPasswordInput } from './password/reset-password.input';
import { GoogleLoginInput } from './google/google-login.input';
import { GoogleSignInService } from './google/google-sign-in.service';
import {
  AuthRequestResult,
  EmailVerificationResult,
  PasswordResetResult,
  RegistrationResult,
} from './models/auth-result.model';
import { PasswordRecoveryService } from './password/password-recovery.service';
import { PasswordSignInService } from './password/password-sign-in.service';
import { RegistrationService } from './registration/registration.service';

@Resolver()
export class AuthResolver {
  constructor(
    private readonly passwordSignInService: PasswordSignInService,
    private readonly registrationService: RegistrationService,
    private readonly passwordRecoveryService: PasswordRecoveryService,
    private readonly googleSignInService: GoogleSignInService,
    private readonly sessionService: SessionService,
  ) {}

  @Mutation(() => User)
  @Throttle(AUTH_RATE_LIMIT)
  login(
    @Args('loginInput') loginInput: LoginInput,
    @Context() context: HttpContext,
  ) {
    return this.passwordSignInService.login(
      loginInput,
      context.req,
      context.res,
    );
  }

  @Mutation(() => RegistrationResult)
  @Throttle(AUTH_RATE_LIMIT)
  register(
    @Args('registerInput') registerInput: RegisterInput,
    @Context('req') request: HttpContext['req'],
  ) {
    return this.registrationService.register(registerInput, request);
  }

  @Mutation(() => AuthRequestResult)
  @Throttle(AUTH_RATE_LIMIT)
  resendEmailVerification(
    @Args('input') input: EmailActionInput,
    @Context('req') request: HttpContext['req'],
  ) {
    return this.registrationService.resendEmailVerification(input, request);
  }

  @Mutation(() => EmailVerificationResult)
  @Throttle(AUTH_RATE_LIMIT)
  verifyEmail(
    @Args('input') input: AuthTokenInput,
    @Context('req') request: HttpContext['req'],
  ) {
    return this.registrationService.verifyEmail(input, request);
  }

  @Mutation(() => AuthRequestResult)
  @Throttle(AUTH_RATE_LIMIT)
  requestPasswordReset(
    @Args('input') input: EmailActionInput,
    @Context('req') request: HttpContext['req'],
  ) {
    return this.passwordRecoveryService.requestPasswordReset(input, request);
  }

  @Mutation(() => PasswordResetResult)
  @Throttle(AUTH_RATE_LIMIT)
  resetPassword(
    @Args('input') input: ResetPasswordInput,
    @Context() context: HttpContext,
  ) {
    return this.passwordRecoveryService.resetPassword(
      input,
      context.req,
      context.res,
    );
  }

  @Mutation(() => User)
  @Throttle(AUTH_RATE_LIMIT)
  googleLogin(
    @Args('googleLoginInput') googleLoginInput: GoogleLoginInput,
    @Context() context: HttpContext,
  ) {
    return this.googleSignInService.login(
      googleLoginInput,
      context.req,
      context.res,
    );
  }

  @Mutation(() => Boolean)
  logout(@Context() context: HttpContext) {
    return this.sessionService.logout(context.req, context.res);
  }

  @UseGuards(GqlSessionAuthGuard)
  @Mutation(() => Boolean)
  logoutAll(
    @Context('req') request: HttpContext['req'] & { user: AuthenticatedUser },
    @Context('res') response: HttpContext['res'],
  ) {
    return this.sessionService.logoutAll(request.user.id, request, response);
  }
}
