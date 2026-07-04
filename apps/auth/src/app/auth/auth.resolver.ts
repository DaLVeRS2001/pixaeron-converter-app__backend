import { UseGuards } from '@nestjs/common';
import { HttpContext } from '@pixaeron/nestjs';
import { Args, Context, Mutation, Resolver } from '@pixaeron/graphql';
import { User } from '../user/models/user.model';
import { AuthService } from './auth.service';
import { LoginInput } from './dto/login.input';
import { RegisterInput } from './dto/register.input';

@Resolver()
export class AuthResolver {
  constructor(private readonly authService: AuthService) {}

  @Mutation(() => User)
  async login(
    @Args('loginInput') loginInput: LoginInput,
    @Context() context: HttpContext,
  ) {
    return this.authService.login(loginInput, context.res);
  }

  @Mutation(() => User)
  async register(
    @Args('registerInput') registerInput: RegisterInput,
    @Context() context: HttpContext,
  ) {
    return this.authService.register(registerInput, context.res);
  }
}
