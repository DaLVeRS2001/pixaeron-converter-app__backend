import {
  ConflictException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { compare } from 'bcryptjs';
import { Response } from 'express';

import { UserService } from '../user/user.service';
import { LoginInput } from './dto/login.input';
import { RegisterInput } from './dto/register.input';
import { TokenPayload } from './interfaces/token-payload.interface';

@Injectable()
export class AuthService {
  constructor(
    private readonly userService: UserService,
    private readonly configService: ConfigService,
    private readonly jwtService: JwtService,
  ) {}

  private readonly invalidCredentialsMessage = 'Invalid email or password';

  async login({ email, password }: LoginInput, response: Response) {
    const user = await this.verifyUser(email, password);

    this.setAuthenticationCookie(user.id, response);

    return user;
  }

  async register(
    { email, password, username }: RegisterInput,
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

    this.setAuthenticationCookie(user.id, response);

    return user;
  }

  private async verifyUser(email: string, password: string) {
    const normalizedEmail = email.trim().toLowerCase();

    const user = await this.userService.getUser({
      email: normalizedEmail,
    });

    if (!user) throw new UnauthorizedException(this.invalidCredentialsMessage);

    const isPasswordValid = await compare(password, user.password);

    if (!isPasswordValid)
      throw new UnauthorizedException(this.invalidCredentialsMessage);

    return user;
  }

  private setAuthenticationCookie(userId: number, response: Response) {
    const tokenPayload: TokenPayload = {
      userId,
    };

    const accessToken = this.jwtService.sign(tokenPayload);

    response.cookie('Authentication', accessToken, {
      httpOnly: true,
      secure: this.configService.get('NODE_ENV') === 'production',
      path: '/',
      sameSite: 'lax',
      maxAge: Number(this.configService.getOrThrow('JWT_EXPIRATION_MS')),
    });
  }
}
