import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import { User } from '../user/models/user.model';
import { LoginInput } from './dto/login.input';
import { AuthService } from './auth.service';
import { Request, Response } from 'express';

@Resolver()
export class AuthResolver {
  constructor(private readonly authService: AuthService) {}

  @Mutation(() => User)
  async login(
    @Args('loginInput') loginInput: LoginInput,
    @Context() context: { req: Request; res: Response },
  ) {
    return this.authService.login(loginInput, context.res);
  }
}
