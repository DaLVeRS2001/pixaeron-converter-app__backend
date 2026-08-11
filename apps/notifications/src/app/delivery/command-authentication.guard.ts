import { status as grpcStatus, type Metadata } from '@grpc/grpc-js';
import {
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RpcException } from '@nestjs/microservices';
import { createHash, timingSafeEqual } from 'node:crypto';

export const COMMAND_SECRET_METADATA_KEY = 'x-pixaeron-command-secret';

@Injectable()
export class CommandAuthenticationGuard implements CanActivate {
  private readonly expectedDigest: Buffer | null;

  constructor(configService: ConfigService) {
    const secret = configService.get<string>('NOTIFICATIONS_COMMAND_SECRET');
    this.expectedDigest = secret ? digest(secret) : null;
  }

  canActivate(context: ExecutionContext): boolean {
    if (!this.expectedDigest) return true;

    const metadata = context.switchToRpc().getContext<Metadata>();
    const presented = metadata.get(COMMAND_SECRET_METADATA_KEY)[0];

    if (
      typeof presented !== 'string' ||
      !timingSafeEqual(digest(presented), this.expectedDigest)
    ) {
      throw new RpcException({
        code: grpcStatus.UNAUTHENTICATED,
        message: 'Command channel authentication failed',
      });
    }

    return true;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}
