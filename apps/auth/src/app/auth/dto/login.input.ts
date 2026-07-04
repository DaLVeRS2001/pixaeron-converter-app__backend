import { Field, InputType } from '@pixaeron/graphql';
import { IsNotEmpty } from 'class-validator';

@InputType()
export class LoginInput {
  @Field()
  @IsNotEmpty()
  email!: string;

  @Field()
  @IsNotEmpty()
  password!: string;
}
