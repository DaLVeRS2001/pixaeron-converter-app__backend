import { createHash } from 'node:crypto';

type JsonObject = Record<string, unknown>;

export type SesFeedbackSource = {
  topicArn: string;
  sendingAccountId: string;
  sourceArn: string;
  configurationSet: string;
};

type FeedbackBase = {
  snsMessageId: string;
  sesMessageId: string;
  recipient: string;
  requestId?: string;
  mailTimestamp: Date;
  providerTimestamp: Date;
};

export type SesFeedback =
  | (FeedbackBase & { eventType: 'SEND' })
  | (FeedbackBase & { eventType: 'DELIVERY' })
  | (FeedbackBase & { eventType: 'DELIVERY_DELAY'; delayType: string })
  | (FeedbackBase & {
      eventType: 'BOUNCE';
      bounceType: string;
      bounceSubType: string;
      feedbackId: string;
    })
  | (FeedbackBase & {
      eventType: 'COMPLAINT';
      complaintSubType?: string;
      complaintFeedbackType?: string;
      feedbackId: string;
    })
  | (FeedbackBase & { eventType: 'REJECT'; reason: string })
  | (FeedbackBase & {
      eventType: 'RENDERING_FAILURE';
      templateName: string;
    });

export function parseSesFeedback(
  sqsBody: string,
  expectedSource: SesFeedbackSource,
): SesFeedback {
  const envelope = parseObject(sqsBody, 'SNS envelope');

  if (readString(envelope, 'Type') !== 'Notification') {
    return invalid('SNS Type');
  }
  if (readString(envelope, 'TopicArn') !== expectedSource.topicArn) {
    return invalid('SNS TopicArn');
  }

  const snsMessageId = readString(envelope, 'MessageId');
  const event = parseObject(readString(envelope, 'Message'), 'SES event');
  const mail = readObject(event, 'mail');

  validateSource(mail, expectedSource);

  const destination = readStringArray(mail, 'destination');
  if (destination.length !== 1 || !destination[0].trim()) {
    return invalid('mail.destination');
  }

  const tags = readObject(mail, 'tags');
  const configurationSets = readStringArray(tags, 'ses:configuration-set');
  const hasExpectedConfigurationSet =
    configurationSets.length === 1 &&
    configurationSets[0] === expectedSource.configurationSet;
  if (!hasExpectedConfigurationSet) {
    return invalid('mail.tags.ses:configuration-set');
  }

  const mailTimestamp = readDate(mail, 'timestamp');
  const base: FeedbackBase = {
    snsMessageId,
    sesMessageId: readString(mail, 'messageId'),
    recipient: destination[0],
    requestId: readOptionalSingleTag(tags, 'request-id'),
    mailTimestamp,
    providerTimestamp: mailTimestamp,
  };

  return normalizeEvent(event, base, mailTimestamp);
}

export function createSesFeedbackFingerprint(
  event: SesFeedback,
  recipientHash: string,
): string {
  if (!recipientHash) return invalid('recipient hash');

  const identity =
    event.eventType === 'BOUNCE' || event.eventType === 'COMPLAINT'
      ? [
          'v1',
          event.sesMessageId,
          event.eventType,
          event.feedbackId,
          recipientHash,
        ]
      : [
          'v1',
          event.sesMessageId,
          event.eventType,
          eventSubtype(event),
          event.providerTimestamp.toISOString(),
          recipientHash,
        ];

  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function normalizeEvent(
  event: JsonObject,
  base: FeedbackBase,
  mailTimestamp: Date,
): SesFeedback {
  switch (readString(event, 'eventType')) {
    case 'Send':
      readObject(event, 'send');
      return { ...base, eventType: 'SEND' };
    case 'Delivery': {
      const delivery = readObject(event, 'delivery');
      return {
        ...base,
        eventType: 'DELIVERY',
        providerTimestamp: readDate(delivery, 'timestamp'),
      };
    }
    case 'DeliveryDelay': {
      const delay = readObject(event, 'deliveryDelay');
      return {
        ...base,
        eventType: 'DELIVERY_DELAY',
        delayType: readString(delay, 'delayType'),
        providerTimestamp:
          readOptionalDate(delay, 'timestamp') ?? mailTimestamp,
      };
    }
    case 'Bounce': {
      const bounce = readObject(event, 'bounce');
      return {
        ...base,
        eventType: 'BOUNCE',
        bounceType: readString(bounce, 'bounceType'),
        bounceSubType: readString(bounce, 'bounceSubType'),
        feedbackId: readString(bounce, 'feedbackId'),
        providerTimestamp: readDate(bounce, 'timestamp'),
      };
    }
    case 'Complaint': {
      const complaint = readObject(event, 'complaint');
      return {
        ...base,
        eventType: 'COMPLAINT',
        complaintSubType: readOptionalString(complaint, 'complaintSubType'),
        complaintFeedbackType: readOptionalString(
          complaint,
          'complaintFeedbackType',
        ),
        feedbackId: readString(complaint, 'feedbackId'),
        providerTimestamp: readDate(complaint, 'timestamp'),
      };
    }
    case 'Reject': {
      const reject = readObject(event, 'reject');
      return {
        ...base,
        eventType: 'REJECT',
        reason: readString(reject, 'reason'),
      };
    }
    case 'Rendering Failure': {
      const failure = readObject(event, 'failure');
      readString(failure, 'errorMessage');
      return {
        ...base,
        eventType: 'RENDERING_FAILURE',
        templateName: readString(failure, 'templateName'),
      };
    }
    default:
      return invalid('eventType');
  }
}

function validateSource(mail: JsonObject, expected: SesFeedbackSource): void {
  if (readString(mail, 'sendingAccountId') !== expected.sendingAccountId) {
    invalid('mail.sendingAccountId');
  }
  if (readString(mail, 'sourceArn') !== expected.sourceArn) {
    invalid('mail.sourceArn');
  }
}

function eventSubtype(event: SesFeedback): string {
  switch (event.eventType) {
    case 'DELIVERY_DELAY':
      return event.delayType;
    case 'REJECT':
      return event.reason;
    default:
      return '';
  }
}

function parseObject(value: string, field: string): JsonObject {
  try {
    return asObject(JSON.parse(value), field);
  } catch {
    return invalid(field);
  }
}

function readObject(object: JsonObject, field: string): JsonObject {
  return asObject(object[field], field);
}

function asObject(value: unknown, field: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(field);
  }
  return value as JsonObject;
}

function readString(object: JsonObject, field: string): string {
  const value = object[field];
  return typeof value === 'string' && value.length > 0 ? value : invalid(field);
}

function readOptionalString(
  object: JsonObject,
  field: string,
): string | undefined {
  const value = object[field];
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string' && value.length > 0 ? value : invalid(field);
}

function readStringArray(object: JsonObject, field: string): string[] {
  const value = object[field];
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : invalid(field);
}

function readOptionalSingleTag(
  tags: JsonObject,
  name: string,
): string | undefined {
  if (tags[name] === undefined) return undefined;

  const values = readStringArray(tags, name);
  return values.length === 1 && values[0].length > 0
    ? values[0]
    : invalid(`mail.tags.${name}`);
}

function readDate(object: JsonObject, field: string): Date {
  const date = new Date(readString(object, field));
  return Number.isNaN(date.getTime()) ? invalid(field) : date;
}

function readOptionalDate(object: JsonObject, field: string): Date | undefined {
  return object[field] === undefined ? undefined : readDate(object, field);
}

function invalid(field: string): never {
  throw new Error(`Invalid SES feedback: ${field}`);
}
