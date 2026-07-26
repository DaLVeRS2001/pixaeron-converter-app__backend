import { Field, InputType } from '@pixaeron/graphql';
import {
  IsByteLength,
  IsString,
  IsStrongPassword,
  MaxLength,
  MinLength,
} from 'class-validator';

@InputType()
export class ResetPasswordInput {
  @Field()
  @IsString()
  @MinLength(32)
  @MaxLength(512)
  token!: string;

  @Field()
  @IsStrongPassword()
  @IsByteLength(8, 72)
  password!: string;
}
