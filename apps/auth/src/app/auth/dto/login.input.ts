import { Field, InputType } from '@pixaeron/graphql';
import { IsBoolean, IsNotEmpty, IsOptional } from 'class-validator';

@InputType()
export class LoginInput {
  @Field()
  @IsNotEmpty()
  email!: string;

  @Field()
  @IsNotEmpty()
  password!: string;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;
}
