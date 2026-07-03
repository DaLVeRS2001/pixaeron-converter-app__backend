import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';
import { User } from './models/user.model';
import { CreateUserInput } from './dto/create-user.inputs';
import { UserService } from './user.service';

@Resolver(() => User)
export class UserResolver {
  constructor(private readonly userService: UserService) {}

  @Mutation(() => User)
  async createUser(@Args('createUserInput') CreateUserInput: CreateUserInput) {
    return this.userService.createUser(CreateUserInput);
  }

  @Query(() => User)
  async getUser(@Args('id', { type: () => Int }) id: number) {
    return this.userService.getUser(id);
  }
}
