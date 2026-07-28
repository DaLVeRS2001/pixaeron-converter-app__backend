import { Module } from '@nestjs/common';

import { SessionModule } from '../session/session.module';
import { UserResolver } from './user.resolver';
import { UserService } from './user.service';

export const USER_RESOLVERS = [UserResolver];

@Module({
  imports: [SessionModule],
  providers: [UserService, ...USER_RESOLVERS],
  exports: [UserService],
})
export class UserModule {}
