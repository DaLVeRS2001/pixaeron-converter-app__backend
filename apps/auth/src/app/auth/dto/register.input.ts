import { Field, InputType } from '@pixaeron/graphql';
import {
  IsBoolean,
  IsEmail,
  IsOptional,
  IsString,
  IsStrongPassword,
  MaxLength,
  MinLength,
} from 'class-validator';

@InputType()
export class RegisterInput {
  @Field()
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  username!: string;

  @Field()
  @IsEmail()
  email!: string;

  @Field()
  @IsStrongPassword()
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
