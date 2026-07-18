import { Field, InputType } from '@pixaeron/graphql';
import { IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';

@InputType()
export class GoogleLoginInput {
  @Field()
  @IsNotEmpty()
  @IsString()
  idToken!: string;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  captchaToken?: string;
}
