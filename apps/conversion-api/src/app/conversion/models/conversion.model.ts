import {
  Field,
  Float,
  ID,
  Int,
  ObjectType,
  registerEnumType,
} from '@pixaeron/graphql';

import {
  ConversionBatchStatus,
  ConversionFileStatus,
  ConversionPlanCode,
  ConversionResultKind,
} from '../../../generated/prisma/client';

registerEnumType(ConversionBatchStatus, { name: 'ConversionBatchStatus' });
registerEnumType(ConversionFileStatus, { name: 'ConversionFileStatus' });
registerEnumType(ConversionPlanCode, { name: 'ConversionPlanCode' });
registerEnumType(ConversionResultKind, { name: 'ConversionResultKind' });

@ObjectType()
export class ConversionUploadField {
  @Field()
  name!: string;

  @Field()
  value!: string;
}

@ObjectType()
export class ConversionUploadTarget {
  @Field()
  url!: string;

  @Field(() => [ConversionUploadField])
  fields!: ConversionUploadField[];
}

@ObjectType()
export class ConversionFile {
  @Field(() => ID)
  id!: string;

  @Field(() => ConversionFileStatus)
  status!: ConversionFileStatus;

  @Field(() => Int, { nullable: true })
  inputBytes!: number | null;

  @Field(() => ConversionResultKind, { nullable: true })
  resultKind!: ConversionResultKind | null;

  @Field(() => Int, { nullable: true })
  outputBytes!: number | null;

  @Field(() => String, { nullable: true })
  outputFormat!: string | null;

  @Field(() => Int, { nullable: true })
  width!: number | null;

  @Field(() => Int, { nullable: true })
  height!: number | null;

  @Field(() => String, { nullable: true })
  failureCode!: string | null;

  @Field(() => String, { nullable: true })
  downloadUrl!: string | null;

  @Field(() => ConversionUploadTarget, { nullable: true })
  upload!: ConversionUploadTarget | null;
}

@ObjectType()
export class ConversionBatch {
  @Field(() => ID)
  id!: string;

  @Field(() => ConversionBatchStatus)
  status!: ConversionBatchStatus;

  @Field(() => Int)
  fileCount!: number;

  @Field()
  expiresAt!: Date;

  @Field(() => String, { nullable: true })
  batchToken!: string | null;

  @Field(() => [ConversionFile])
  files!: ConversionFile[];
}

@ObjectType()
export class CompleteConversionUploadsPayload {
  @Field(() => ConversionBatch)
  batch!: ConversionBatch;

  @Field(() => Int)
  admittedFiles!: number;

  @Field(() => Int)
  verifiedFiles!: number;

  @Field(() => Int)
  missingFiles!: number;
}

@ObjectType()
export class ConversionEntitlement {
  @Field(() => ConversionPlanCode)
  planCode!: ConversionPlanCode;

  @Field(() => Int)
  maxBatchFiles!: number;

  @Field(() => Int)
  maxFileBytes!: number;

  @Field(() => Int, { nullable: true })
  dailyFiles!: number | null;

  @Field(() => Int, { nullable: true })
  remainingToday!: number | null;

  @Field(() => Int)
  maxConcurrentFiles!: number;

  @Field(() => Float, { nullable: true })
  storageBytes!: number | null;

  @Field(() => Float, { nullable: true })
  storageBytesUsed!: number | null;
}

@ObjectType()
export class ConversionBatchPage {
  @Field(() => [ConversionBatch])
  items!: ConversionBatch[];

  @Field(() => Int)
  total!: number;
}
