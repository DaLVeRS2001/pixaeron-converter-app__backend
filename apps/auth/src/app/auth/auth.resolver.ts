import { Args, Context, Mutation, Resolver } from '@nestjs/graphql';
import { User } from '../user/models/user.model';
import { LoginInput } from './dto/login.input';
import { AuthService } from './auth.service';
import { HttpContext } from '@pixaeron/nestjs';

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
}
