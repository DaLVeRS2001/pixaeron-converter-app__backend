import { Field, InputType } from '@pixaeron/graphql';
import {
  IsBoolean,
  IsByteLength,
  IsEmail,
  IsOptional,
  IsString,
  IsStrongPassword,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

@InputType()
export class RegisterInput {
  @Field()
  @IsString()
  @MinLength(3)
  @MaxLength(32)
  @Matches(/^\S(?:.*\S)?$/)
  username!: string;

  @Field()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Field()
  @IsStrongPassword()
  @IsByteLength(8, 72)
  password!: string;

  @Field(() => Boolean, { nullable: true })
  @IsOptional()
  @IsBoolean()
  legalConsentAccepted?: boolean;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  legalConsentVersion?: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  captchaToken?: string;
}
