import { Field, InputType } from '@pixaeron/graphql';
import {
  IsBoolean,
  IsByteLength,
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

@InputType()
export class LoginInput {
  @Field()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Field()
  @IsString()
  @IsByteLength(1, 72)
  password!: string;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  rememberMe?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  captchaToken?: string;
}
