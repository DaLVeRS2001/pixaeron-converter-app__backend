import { Field, InputType } from '@pixaeron/graphql';
import {
  IsEmail,
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
}
