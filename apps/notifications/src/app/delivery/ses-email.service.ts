import {
  GetAccountCommand,
  GetConfigurationSetCommand,
  GetConfigurationSetEventDestinationsCommand,
  GetEmailIdentityCommand,
  MessageRejected,
  SendEmailCommand,
  SESv2Client,
  SESv2ServiceException,
  type EventDestination,
  type GetAccountCommandOutput,
  type GetConfigurationSetCommandOutput,
  type GetConfigurationSetEventDestinationsCommandOutput,
  type GetEmailIdentityCommandOutput,
} from '@aws-sdk/client-sesv2';
import {
  Inject,
  Injectable,
  type OnModuleInit,
  type Provider,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import type { SecurityEmailContent } from './email-templates';

export const SES_EMAIL_CLIENT = Symbol('SES_EMAIL_CLIENT');
export const CALLER_DEADLINE_EXCEEDED_CODE = 'CALLER_DEADLINE_EXCEEDED';

const REQUIRED_FEEDBACK_EVENTS = [
  'BOUNCE',
  'COMPLAINT',
  'DELIVERY',
  'DELIVERY_DELAY',
  'REJECT',
  'RENDERING_FAILURE',
  'SEND',
] as const;

export type SesSubmissionResult =
  | { status: 'ACCEPTED'; messageId: string }
  | {
      status: 'FAILED' | 'REJECTED' | 'SUBMISSION_UNKNOWN';
      code: string;
    };

export const sesEmailClientProvider: Provider = {
  provide: SES_EMAIL_CLIENT,
  inject: [ConfigService],
  useFactory: (configService: ConfigService): SESv2Client =>
    new SESv2Client({
      region: configService.getOrThrow<string>('AWS_REGION'),
      maxAttempts: 1,
    }),
};

@Injectable()
export class SesEmailService implements OnModuleInit {
  private readonly configurationSet: string;
  private readonly expectedIdentity: string;
  private readonly feedbackTopicArn: string;
  private readonly fromEmailAddress: string;
  private readonly isProduction: boolean;
  private readonly requestTimeoutMs: number;

  constructor(
    @Inject(SES_EMAIL_CLIENT)
    private readonly client: Pick<SESv2Client, 'send'>,
    configService: ConfigService,
  ) {
    this.configurationSet = configService.getOrThrow<string>(
      'SES_CONFIGURATION_SET',
    );
    this.feedbackTopicArn = configService.getOrThrow<string>(
      'SES_FEEDBACK_TOPIC_ARN',
    );
    this.fromEmailAddress = configService.getOrThrow<string>('SES_FROM_EMAIL');
    this.isProduction =
      configService.getOrThrow<string>('NODE_ENV') === 'production';
    this.requestTimeoutMs = Number(
      configService.getOrThrow<string>('SES_REQUEST_TIMEOUT_MS'),
    );

    const identityArn = configService.getOrThrow<string>(
      'SES_EXPECTED_SOURCE_ARN',
    );
    this.expectedIdentity = identityArn.slice(
      identityArn.indexOf('identity/') + 'identity/'.length,
    );
  }

  async onModuleInit(): Promise<void> {
    if (!this.isProduction) return;

    const state = await this.loadProductionConfiguration();
    assertAccountReady(state.account);
    assertIdentityReady(state.identity);
    assertConfigurationSetReady(state.configurationSet);
    assertFeedbackDestinationReady(
      state.destinations.EventDestinations,
      this.feedbackTopicArn,
    );
    assertSenderMatchesIdentity(this.fromEmailAddress, this.expectedIdentity);
  }

  async submit(
    recipient: string,
    requestId: string,
    content: SecurityEmailContent,
    remainingBudgetMs = this.requestTimeoutMs,
  ): Promise<SesSubmissionResult> {
    if (remainingBudgetMs <= 0) {
      return { status: 'FAILED', code: CALLER_DEADLINE_EXCEEDED_CODE };
    }

    try {
      const result = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: this.fromEmailAddress,
          Destination: { ToAddresses: [recipient] },
          Content: {
            Simple: {
              Subject: { Data: content.subject, Charset: 'UTF-8' },
              Body: {
                Text: { Data: content.text, Charset: 'UTF-8' },
                Html: { Data: content.html, Charset: 'UTF-8' },
              },
            },
          },
          ConfigurationSetName: this.configurationSet,
          EmailTags: [{ Name: 'request-id', Value: requestId }],
        }),
        this.requestOptions(remainingBudgetMs),
      );

      return result.MessageId
        ? { status: 'ACCEPTED', messageId: result.MessageId }
        : {
            status: 'SUBMISSION_UNKNOWN',
            code: 'SES_MESSAGE_ID_MISSING',
          };
    } catch (error) {
      return classifySesError(error);
    }
  }

  private async loadProductionConfiguration(): Promise<{
    account: GetAccountCommandOutput;
    identity: GetEmailIdentityCommandOutput;
    configurationSet: GetConfigurationSetCommandOutput;
    destinations: GetConfigurationSetEventDestinationsCommandOutput;
  }> {
    try {
      const [account, identity, configurationSet, destinations] =
        await Promise.all([
          this.client.send(new GetAccountCommand({}), this.requestOptions()),
          this.client.send(
            new GetEmailIdentityCommand({
              EmailIdentity: this.expectedIdentity,
            }),
            this.requestOptions(),
          ),
          this.client.send(
            new GetConfigurationSetCommand({
              ConfigurationSetName: this.configurationSet,
            }),
            this.requestOptions(),
          ),
          this.client.send(
            new GetConfigurationSetEventDestinationsCommand({
              ConfigurationSetName: this.configurationSet,
            }),
            this.requestOptions(),
          ),
        ]);

      return { account, identity, configurationSet, destinations };
    } catch {
      throw new Error('SES production preflight request failed');
    }
  }

  private requestOptions(remainingBudgetMs = this.requestTimeoutMs): {
    abortSignal: AbortSignal;
  } {
    const timeoutMs = Math.min(
      this.requestTimeoutMs,
      Math.max(0, remainingBudgetMs),
    );

    return {
      abortSignal:
        timeoutMs === 0 ? AbortSignal.abort() : AbortSignal.timeout(timeoutMs),
    };
  }
}

function assertAccountReady(account: GetAccountCommandOutput): void {
  const suppressionReasons = account.SuppressionAttributes?.SuppressedReasons;
  const sendingUnavailable =
    account.ProductionAccessEnabled !== true ||
    account.SendingEnabled !== true ||
    account.EnforcementStatus === 'SHUTDOWN';

  if (sendingUnavailable) {
    throw new Error('SES account is not enabled for production sending');
  }
  if (!hasRequiredSuppressionReasons(suppressionReasons)) {
    throw new Error(
      'SES account suppression must include bounce and complaint',
    );
  }
}

function assertIdentityReady(identity: GetEmailIdentityCommandOutput): void {
  const dkimReady =
    identity.DkimAttributes?.SigningEnabled === true &&
    identity.DkimAttributes.Status === 'SUCCESS';
  const mailFromReady =
    identity.MailFromAttributes?.MailFromDomainStatus === 'SUCCESS' &&
    identity.MailFromAttributes.BehaviorOnMxFailure === 'USE_DEFAULT_VALUE';
  const identityReady =
    identity.VerifiedForSendingStatus === true &&
    identity.VerificationStatus === 'SUCCESS';

  if (!identityReady || !dkimReady || !mailFromReady) {
    throw new Error('SES source identity is not production-ready');
  }
}

function assertConfigurationSetReady(
  configurationSet: GetConfigurationSetCommandOutput,
): void {
  if (configurationSet.SendingOptions?.SendingEnabled === false) {
    throw new Error('SES configuration set sending is disabled');
  }

  const suppression = configurationSet.SuppressionOptions;
  if (suppression?.SuppressionScope === 'TENANT') {
    throw new Error('SES configuration set must not use tenant suppression');
  }
  if (
    suppression?.SuppressedReasons &&
    !hasRequiredSuppressionReasons(suppression.SuppressedReasons)
  ) {
    throw new Error(
      'SES configuration set suppression must include bounce and complaint',
    );
  }
}

function assertFeedbackDestinationReady(
  destinations: EventDestination[] | undefined,
  expectedTopicArn: string,
): void {
  const destination = destinations?.find(
    (candidate) =>
      candidate.Enabled === true &&
      candidate.SnsDestination?.TopicArn === expectedTopicArn,
  );
  const configuredEvents = new Set(destination?.MatchingEventTypes ?? []);
  const hasEveryEvent = REQUIRED_FEEDBACK_EVENTS.every((event) =>
    configuredEvents.has(event),
  );

  if (!hasEveryEvent) {
    throw new Error('SES feedback SNS destination is incomplete or disabled');
  }
}

function assertSenderMatchesIdentity(
  fromEmailAddress: string,
  expectedIdentity: string,
): void {
  const match = /^(?:[^<>\r\n]*<([^<>\r\n]+)>|([^<>\r\n]+))$/.exec(
    fromEmailAddress,
  );
  const sender = (match?.[1] ?? match?.[2] ?? '').trim().toLowerCase();
  const identity = expectedIdentity.toLowerCase();
  const matchesIdentity = identity.includes('@')
    ? sender === identity
    : sender.endsWith(`@${identity}`);

  if (!matchesIdentity) {
    throw new Error('SES sender does not match the expected source identity');
  }
}

function hasRequiredSuppressionReasons(
  reasons: readonly string[] | undefined,
): boolean {
  return reasons?.includes('BOUNCE') === true && reasons.includes('COMPLAINT');
}

function classifySesError(error: unknown): SesSubmissionResult {
  if (error instanceof MessageRejected) {
    return { status: 'REJECTED', code: 'SES_MESSAGE_REJECTED' };
  }

  if (error instanceof Error && error.name === 'CredentialsProviderError') {
    return { status: 'FAILED', code: 'SES_CREDENTIALS_UNAVAILABLE' };
  }

  if (error instanceof SESv2ServiceException) {
    const knownFailureCode = knownClientFailureCode(error.name);
    if (knownFailureCode) {
      return { status: 'FAILED', code: knownFailureCode };
    }

    if (isPreAcceptanceClientFailure(error)) {
      return { status: 'FAILED', code: 'SES_CLIENT_ERROR' };
    }
  }

  return {
    status: 'SUBMISSION_UNKNOWN',
    code: 'SES_SUBMISSION_UNKNOWN',
  };
}

function knownClientFailureCode(name: string): string | undefined {
  switch (name) {
    case 'AccessDeniedException':
      return 'SES_ACCESS_DENIED';
    case 'AccountSuspendedException':
      return 'SES_ACCOUNT_SUSPENDED';
    case 'BadRequestException':
      return 'SES_BAD_REQUEST';
    case 'ExpiredTokenException':
      return 'SES_EXPIRED_TOKEN';
    case 'IncompleteSignature':
      return 'SES_INCOMPLETE_SIGNATURE';
    case 'LimitExceededException':
      return 'SES_LIMIT_EXCEEDED';
    case 'MailFromDomainNotVerifiedException':
      return 'SES_MAIL_FROM_NOT_VERIFIED';
    case 'NotAuthorized':
      return 'SES_NOT_AUTHORIZED';
    case 'NotFoundException':
      return 'SES_RESOURCE_NOT_FOUND';
    case 'SendingPausedException':
      return 'SES_SENDING_PAUSED';
    case 'TooManyRequestsException':
    case 'ThrottlingException':
      return 'SES_TOO_MANY_REQUESTS';
    case 'UnrecognizedClientException':
      return 'SES_UNRECOGNIZED_CLIENT';
    default:
      return undefined;
  }
}

function isPreAcceptanceClientFailure(error: SESv2ServiceException): boolean {
  const statusCode = error.$metadata.httpStatusCode;
  const responseMayBeLost = [
    'RequestAbortedException',
    'RequestTimeout',
    'RequestTimeoutException',
  ].includes(error.name);

  return (
    statusCode !== undefined &&
    statusCode >= 400 &&
    statusCode < 500 &&
    statusCode !== 408 &&
    !responseMayBeLost
  );
}
