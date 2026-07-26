import { Field, InputType } from '@pixaeron/graphql';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';

@InputType()
export class EmailActionInput {
  @Field()
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Field({ nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  captchaToken?: string;
}
