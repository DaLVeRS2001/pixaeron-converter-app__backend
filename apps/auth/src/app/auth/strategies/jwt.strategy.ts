import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import type { Request } from 'express';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { TokenPayload } from '../interfaces/token-payload.interface';
import { UserService } from '../../user/user.service';

type JwtRequest = Request & {
  cookies?: { Authentication?: string };
  token?: string;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    configService: ConfigService,
    private readonly userService: UserService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromExtractors<JwtRequest>([
        (request) => request.cookies?.Authentication || request.token || null,
      ]),
      secretOrKey: configService.getOrThrow('JWT_SECRET'),
    });
  }

  async validate(payload: TokenPayload) {
    const user = await this.userService.getUser({ id: payload.userId });

    if (!user) throw new UnauthorizedException();

    return user;
  }
}
