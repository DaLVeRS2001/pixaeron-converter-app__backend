import { Field, InputType, Int } from '@pixaeron/graphql';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from 'class-validator';

import {
  ConversionMode,
  ConversionStrength,
} from '../../../generated/prisma/client';

@InputType()
export class CreateConversionBatchInput {
  @Field(() => Int)
  @IsInt()
  @Min(1)
  @Max(100)
  fileCount!: number;

  @Field(() => ConversionMode, { nullable: true })
  @IsOptional()
  @IsEnum(ConversionMode)
  mode?: ConversionMode;

  @Field(() => ConversionStrength, { nullable: true })
  @IsOptional()
  @IsEnum(ConversionStrength)
  strength?: ConversionStrength;

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
