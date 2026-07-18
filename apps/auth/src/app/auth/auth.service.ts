import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { compare } from 'bcryptjs';
import { Request, Response } from 'express';

import { SessionEventType } from '../../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SessionAuditService } from '../session/audit/session-audit.service';
import { SessionService } from '../session/services/session.service';
import { UserService } from '../user/user.service';
import { CaptchaService } from './captcha.service';
import { LoginInput } from './dto/login.input';
import { RegisterInput } from './dto/register.input';
import { GoogleLoginInput } from './dto/google-login.input';
import { GoogleAuthService } from './google-auth.service';

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userService: UserService,
    private readonly sessionService: SessionService,
    private readonly sessionAuditService: SessionAuditService,
    private readonly captchaService: CaptchaService,
    private readonly googleAuthService: GoogleAuthService,
  ) {}

  private readonly invalidCredentialsMessage = 'Invalid email or password';

  async login(
    { email, password, rememberMe = false, captchaToken }: LoginInput,
    request: Request,
    response: Response,
  ) {
    await this.captchaService.verify(captchaToken, request, 'login');

    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.userService.getUser({ email: normalizedEmail });

    if (!user?.password) {
      await this.logFailedLogin(request, user?.id);
      throw new UnauthorizedException(this.invalidCredentialsMessage);
    }

    const isPasswordValid = await compare(password, user.password);

    if (!isPasswordValid) {
      await this.logFailedLogin(request, user.id);
      throw new UnauthorizedException(this.invalidCredentialsMessage);
    }

    return this.sessionService.createSession(
      user.id,
      request,
      response,
      SessionEventType.LOGIN_SUCCESS,
      rememberMe,
    );
  }

  async register(
    {
      email,
      password,
      username,
      rememberMe = false,
      captchaToken,
    }: RegisterInput,
    request: Request,
    response: Response,
  ) {
    await this.captchaService.verify(captchaToken, request, 'register');

    const normalizedEmail = email.trim().toLowerCase();

    const existingUser = await this.userService.getUser({
      email: normalizedEmail,
    });

    if (existingUser) throw new ConflictException('User already exists');

    const user = await this.userService.createUser({
      email: normalizedEmail,
      username,
      password,
    });

    return this.sessionService.createSession(
      user.id,
      request,
      response,
      SessionEventType.REGISTER_SUCCESS,
      rememberMe,
    );
  }

  async googleLogin(
    { idToken, rememberMe = false, captchaToken }: GoogleLoginInput,
    request: Request,
    response: Response,
  ) {
    await this.captchaService.verify(captchaToken, request, 'google_login');

    const googleUser = await this.googleAuthService.verifyIdToken(idToken);

    const user = await this.prisma.$transaction(async (tx) => {
      const account = await tx.account.findUnique({
        where: {
          provider_providerAccountId: {
            provider: 'google',
            providerAccountId: googleUser.providerAccountId,
          },
        },
        include: { user: true },
      });

      if (account) return account.user;

      const existingUser = await tx.user.findUnique({
        where: { email: googleUser.email },
      });

      if (existingUser) {
        await tx.account.create({
          data: {
            userId: existingUser.id,
            provider: 'google',
            providerAccountId: googleUser.providerAccountId,
            email: googleUser.email,
          },
        });

        if (googleUser.emailVerified && !existingUser.emailVerified) {
          return tx.user.update({
            where: { id: existingUser.id },
            data: { emailVerified: true },
          });
        }

        return existingUser;
      }

      return tx.user.create({
        data: {
          email: googleUser.email,
          username: googleUser.username,
          password: null,
          emailVerified: googleUser.emailVerified,
          accounts: {
            create: {
              provider: 'google',
              providerAccountId: googleUser.providerAccountId,
              email: googleUser.email,
            },
          },
        },
      });
    });

    return this.sessionService.createSession(
      user.id,
      request,
      response,
      SessionEventType.LOGIN_SUCCESS,
      rememberMe,
    );
  }

  async logout(request: Request, response: Response) {
    return this.sessionService.logout(request, response);
  }

  async logoutAll(userId: number, request: Request, response: Response) {
    return this.sessionService.logoutAll(userId, request, response);
  }

  private async logFailedLogin(request: Request, userId?: number) {
    await this.sessionAuditService.recordLoginFailed(request, userId);
  }
}
