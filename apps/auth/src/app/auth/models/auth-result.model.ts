import { Field, ObjectType, registerEnumType } from '@pixaeron/graphql';

export enum EmailVerificationStatus {
  VERIFIED = 'VERIFIED',
  ALREADY_VERIFIED = 'ALREADY_VERIFIED',
  EXPIRED = 'EXPIRED',
  INVALID = 'INVALID',
}

export enum PasswordResetStatus {
  RESET = 'RESET',
  EXPIRED = 'EXPIRED',
  INVALID = 'INVALID',
  ALREADY_USED = 'ALREADY_USED',
}

registerEnumType(EmailVerificationStatus, {
  name: 'EmailVerificationStatus',
});
registerEnumType(PasswordResetStatus, { name: 'PasswordResetStatus' });

@ObjectType()
export class RegistrationResult {
  @Field()
  accepted!: boolean;

  @Field()
  email!: string;
}

@ObjectType()
export class AuthRequestResult {
  @Field()
  accepted!: boolean;
}

@ObjectType()
export class EmailVerificationResult {
  @Field(() => EmailVerificationStatus)
  status!: EmailVerificationStatus;
}

@ObjectType()
export class PasswordResetResult {
  @Field(() => PasswordResetStatus)
  status!: PasswordResetStatus;
}
