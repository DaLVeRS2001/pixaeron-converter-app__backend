import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { compare } from 'bcryptjs';
import { Request, Response } from 'express';

import { SessionEventType } from '../../generated/prisma/client';
import { SessionAuditService } from '../session/audit/session-audit.service';
import { SessionService } from '../session/services/session.service';
import { UserService } from '../user/user.service';
import { LoginInput } from './dto/login.input';
import { RegisterInput } from './dto/register.input';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly sessionService: SessionService,
    private readonly sessionAuditService: SessionAuditService,
  ) {}

  private readonly invalidCredentialsMessage = 'Invalid email or password';

  async login(
    { email, password, rememberMe = false }: LoginInput,
    request: Request,
    response: Response,
  ) {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.userService.getUser({ email: normalizedEmail });

    if (!user) {
      await this.logFailedLogin(request);
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
    { email, password, username, rememberMe = false }: RegisterInput,
    request: Request,
    response: Response,
  ) {
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
