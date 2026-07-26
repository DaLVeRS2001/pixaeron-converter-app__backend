import { Field, InputType } from '@pixaeron/graphql';
import { IsString, MaxLength, MinLength } from 'class-validator';

@InputType()
export class AuthTokenInput {
  @Field()
  @IsString()
  @MinLength(32)
  @MaxLength(512)
  token!: string;
}
