import {
  createSesFeedbackFingerprint,
  parseSesFeedback,
  type SesFeedbackSource,
} from './ses-feedback-parser';

const source: SesFeedbackSource = {
  topicArn: 'arn:aws:sns:eu-central-1:123456789012:pixaeron-feedback',
  sendingAccountId: '123456789012',
  sourceArn: 'arn:aws:ses:eu-central-1:123456789012:identity/pixaeron.com',
  configurationSet: 'pixaeron-transactional',
};

const mailTimestamp = '2026-08-08T10:00:00.000Z';
const eventTimestamp = '2026-08-08T10:01:00.000Z';

describe('parseSesFeedback', () => {
  it.each([
    {
      name: 'Send',
      payload: { eventType: 'Send', send: {} },
      expected: { eventType: 'SEND', providerTimestamp: mailTimestamp },
    },
    {
      name: 'Delivery',
      payload: {
        eventType: 'Delivery',
        delivery: { timestamp: eventTimestamp },
      },
      expected: { eventType: 'DELIVERY', providerTimestamp: eventTimestamp },
    },
    {
      name: 'DeliveryDelay',
      payload: {
        eventType: 'DeliveryDelay',
        deliveryDelay: {
          timestamp: eventTimestamp,
          delayType: 'MailboxFull',
        },
      },
      expected: {
        eventType: 'DELIVERY_DELAY',
        providerTimestamp: eventTimestamp,
        delayType: 'MailboxFull',
      },
    },
    {
      name: 'Bounce',
      payload: {
        eventType: 'Bounce',
        bounce: {
          timestamp: eventTimestamp,
          bounceType: 'Permanent',
          bounceSubType: 'General',
          feedbackId: 'bounce-feedback-id',
        },
      },
      expected: {
        eventType: 'BOUNCE',
        providerTimestamp: eventTimestamp,
        bounceType: 'Permanent',
        bounceSubType: 'General',
        feedbackId: 'bounce-feedback-id',
      },
    },
    {
      name: 'Complaint without complainedRecipients',
      payload: {
        eventType: 'Complaint',
        complaint: {
          timestamp: eventTimestamp,
          feedbackId: 'complaint-feedback-id',
          complaintSubType: null,
          complaintFeedbackType: 'abuse',
        },
      },
      expected: {
        eventType: 'COMPLAINT',
        providerTimestamp: eventTimestamp,
        feedbackId: 'complaint-feedback-id',
        complaintFeedbackType: 'abuse',
      },
    },
    {
      name: 'Reject',
      payload: { eventType: 'Reject', reject: { reason: 'Bad content' } },
      expected: { eventType: 'REJECT', reason: 'Bad content' },
    },
    {
      name: 'Rendering Failure',
      payload: {
        eventType: 'Rendering Failure',
        failure: {
          templateName: 'verify-email',
          errorMessage: 'Missing template attribute',
        },
      },
      expected: {
        eventType: 'RENDERING_FAILURE',
        templateName: 'verify-email',
      },
    },
  ])('normalizes $name', ({ payload, expected }) => {
    const result = parseEvent(payload);

    expect({
      ...result,
      providerTimestamp: result.providerTimestamp.toISOString(),
    }).toMatchObject({
      snsMessageId: 'sns-message-id',
      sesMessageId: 'ses-message-id',
      recipient: 'User@example.com',
      requestId: 'request-id',
      ...expected,
    });
    expect(result.providerTimestamp.toISOString()).toBe(
      expected.providerTimestamp ?? mailTimestamp,
    );
  });

  it('uses the mail timestamp when DeliveryDelay has no timestamp', () => {
    const result = parseEvent({
      eventType: 'DeliveryDelay',
      deliveryDelay: { delayType: 'General' },
    });

    expect(result.providerTimestamp.toISOString()).toBe(mailTimestamp);
  });

  it.each([
    ['Notification type', { Type: 'SubscriptionConfirmation' }, source],
    ['topic ARN', {}, { ...source, topicArn: 'another-topic' }],
    ['sending account', {}, { ...source, sendingAccountId: '000000000000' }],
    ['source ARN', {}, { ...source, sourceArn: 'another-identity' }],
    [
      'configuration set',
      {},
      { ...source, configurationSet: 'another-configuration-set' },
    ],
  ])('rejects a mismatched %s', (_name, envelopeOverrides, expectedSource) => {
    const body = createSnsBody(
      createSesEvent({ eventType: 'Send', send: {} }),
      envelopeOverrides,
    );

    expect(() => parseSesFeedback(body, expectedSource)).toThrow(
      'Invalid SES feedback',
    );
  });

  it.each([
    { destination: [] },
    { destination: [''] },
    { destination: ['   '] },
    { destination: ['first@example.com', 'second@example.com'] },
  ])('rejects destination $destination', ({ destination }) => {
    const event = createSesEvent({ eventType: 'Send', send: {} });
    event.mail.destination = destination;

    expect(() => parseSesFeedback(createSnsBody(event), source)).toThrow(
      'Invalid SES feedback: mail.destination',
    );
  });

  it('rejects multiple configuration-set values', () => {
    const event = createSesEvent({ eventType: 'Send', send: {} });
    event.mail.tags['ses:configuration-set'] = [
      source.configurationSet,
      'unexpected-configuration-set',
    ];

    expect(() => parseSesFeedback(createSnsBody(event), source)).toThrow(
      'Invalid SES feedback: mail.tags.ses:configuration-set',
    );
  });

  it('rejects multiple request-id tags', () => {
    const event = createSesEvent({ eventType: 'Send', send: {} });
    event.mail.tags['request-id'] = ['request-id', 'another-request-id'];

    expect(() => parseSesFeedback(createSnsBody(event), source)).toThrow(
      'Invalid SES feedback: mail.tags.request-id',
    );
  });
  it('rejects raw SES payloads because SNS raw delivery must be disabled', () => {
    const event = createSesEvent({ eventType: 'Send', send: {} });

    expect(() => parseSesFeedback(JSON.stringify(event), source)).toThrow(
      'Invalid SES feedback: Type',
    );
  });

  it('rejects unsupported event types', () => {
    expect(() => parseEvent({ eventType: 'Open', open: {} })).toThrow(
      'Invalid SES feedback: eventType',
    );
  });
});

describe('createSesFeedbackFingerprint', () => {
  it('deduplicates a republished SES event with a new SNS message ID', () => {
    const first = parseEvent({
      eventType: 'Delivery',
      delivery: { timestamp: eventTimestamp },
    });
    const second = { ...first, snsMessageId: 'new-sns-message-id' };

    expect(createSesFeedbackFingerprint(first, 'recipient-hmac')).toBe(
      createSesFeedbackFingerprint(second, 'recipient-hmac'),
    );
  });

  it('uses feedbackId rather than timestamp for bounce identity', () => {
    const first = parseEvent({
      eventType: 'Bounce',
      bounce: {
        timestamp: eventTimestamp,
        bounceType: 'Permanent',
        bounceSubType: 'General',
        feedbackId: 'feedback-id',
      },
    });
    const second = {
      ...first,
      providerTimestamp: new Date('2026-08-08T11:00:00.000Z'),
    };

    expect(createSesFeedbackFingerprint(first, 'recipient-hmac')).toBe(
      createSesFeedbackFingerprint(second, 'recipient-hmac'),
    );
  });

  it('includes the recipient HMAC in semantic identity', () => {
    const event = parseEvent({ eventType: 'Send', send: {} });

    expect(createSesFeedbackFingerprint(event, 'first-hmac')).not.toBe(
      createSesFeedbackFingerprint(event, 'second-hmac'),
    );
  });
});

function parseEvent(payload: Record<string, unknown>) {
  return parseSesFeedback(createSnsBody(createSesEvent(payload)), source);
}

function createSesEvent(payload: Record<string, unknown>) {
  return {
    ...payload,
    mail: {
      timestamp: mailTimestamp,
      messageId: 'ses-message-id',
      sendingAccountId: source.sendingAccountId,
      sourceArn: source.sourceArn,
      destination: ['User@example.com'],
      tags: {
        'ses:configuration-set': [source.configurationSet],
        'request-id': ['request-id'],
      },
    },
  };
}

function createSnsBody(
  event: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    Type: 'Notification',
    MessageId: 'sns-message-id',
    TopicArn: source.topicArn,
    Message: JSON.stringify(event),
    ...overrides,
  });
}
