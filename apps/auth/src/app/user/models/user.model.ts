import { Field, ID, ObjectType } from '@pixaeron/graphql';

@ObjectType()
export class User {
  @Field(() => ID)
  id!: number;

  @Field()
  email!: string;

  @Field()
  username!: string;

  @Field()
  emailVerified!: boolean;
}
