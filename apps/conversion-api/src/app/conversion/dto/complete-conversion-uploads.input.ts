import { Field, ID, InputType } from '@pixaeron/graphql';
import { IsOptional, IsString, IsUUID, Length } from 'class-validator';

@InputType()
export class CompleteConversionUploadsInput {
  @Field(() => ID)
  @IsUUID()
  batchId!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @Length(16, 128)
  batchToken?: string;
}
