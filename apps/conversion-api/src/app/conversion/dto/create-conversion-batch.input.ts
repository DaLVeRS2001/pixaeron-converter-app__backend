import { Field, InputType, Int } from '@pixaeron/graphql';
import { IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';

@InputType()
export class CreateConversionBatchInput {
  @Field(() => Int)
  @IsInt()
  @Min(1)
  @Max(100)
  fileCount!: number;

  @Field()
  @IsString()
  @Length(8, 128)
  idempotencyKey!: string;

  @Field(() => String, { nullable: true })
  @IsOptional()
  @IsString()
  @Length(16, 128)
  batchToken?: string;
}
