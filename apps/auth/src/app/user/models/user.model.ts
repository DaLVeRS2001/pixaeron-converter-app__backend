import { AbstractModel } from '@pixaeron/graphql';
import { Field, ObjectType } from '@nestjs/graphql';

@ObjectType()
export class User extends AbstractModel {
  @Field()
  email!: string;

  @Field()
  username!: string;
}
