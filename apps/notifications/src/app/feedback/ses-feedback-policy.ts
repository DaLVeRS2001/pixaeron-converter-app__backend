import {
  EmailDeliveryEventType,
  EmailDeliveryStatus,
  EmailDestinationStatus,
} from '../../generated/prisma/client';
import type { SesFeedback } from './ses-feedback-parser';

const PROVIDER_SUPPRESSION_SUBTYPES = new Set([
  'emailvalidationsuppressed',
  'suppressed',
  'onaccountsuppressionlist',
  'ontenantsuppressionlist',
]);

export function isTerminalMailboxEvent(feedback: SesFeedback): boolean {
  return (
    feedback.eventType === 'COMPLAINT' ||
    (feedback.eventType === 'BOUNCE' &&
      (feedback.bounceType.toLowerCase() === 'permanent' ||
        isProviderSuppression(feedback)))
  );
}

function isProviderSuppression(feedback: SesFeedback): boolean {
  if (feedback.eventType === 'BOUNCE') {
    return PROVIDER_SUPPRESSION_SUBTYPES.has(
      feedback.bounceSubType.toLowerCase(),
    );
  }
  if (feedback.eventType === 'COMPLAINT' && feedback.complaintSubType) {
    return PROVIDER_SUPPRESSION_SUBTYPES.has(
      feedback.complaintSubType.toLowerCase(),
    );
  }
  return false;
}

export function feedbackPrecedence(feedback: SesFeedback): number {
  if (isProviderSuppression(feedback)) return 70;

  switch (feedback.eventType) {
    case 'COMPLAINT':
      return 60;
    case 'BOUNCE':
      return feedback.bounceType.toLowerCase() === 'permanent' ? 50 : 45;
    case 'REJECT':
    case 'RENDERING_FAILURE':
      return 40;
    case 'DELIVERY':
      return 30;
    case 'DELIVERY_DELAY':
      return 20;
    case 'SEND':
      return 10;
  }
}

export function deliveryStatus(feedback: SesFeedback): EmailDeliveryStatus {
  switch (feedback.eventType) {
    case 'SEND':
      return EmailDeliveryStatus.ACCEPTED;
    case 'DELIVERY':
      return EmailDeliveryStatus.DELIVERED;
    case 'DELIVERY_DELAY':
      return EmailDeliveryStatus.DELAYED;
    case 'BOUNCE':
      return isProviderSuppression(feedback)
        ? EmailDeliveryStatus.SUPPRESSED
        : EmailDeliveryStatus.BOUNCED;
    case 'COMPLAINT':
      return isProviderSuppression(feedback)
        ? EmailDeliveryStatus.SUPPRESSED
        : EmailDeliveryStatus.COMPLAINED;
    case 'REJECT':
      return EmailDeliveryStatus.REJECTED;
    case 'RENDERING_FAILURE':
      return EmailDeliveryStatus.FAILED;
  }
}

export function destinationStatus(
  feedback: SesFeedback,
): EmailDestinationStatus | undefined {
  switch (feedback.eventType) {
    case 'DELIVERY':
      return EmailDestinationStatus.ACTIVE;
    case 'DELIVERY_DELAY':
      return EmailDestinationStatus.TEMPORARY_FAILURE;
    case 'BOUNCE':
      return feedback.bounceType.toLowerCase() === 'transient'
        ? EmailDestinationStatus.TEMPORARY_FAILURE
        : undefined;
    default:
      return undefined;
  }
}

export function deliveryFailureCode(feedback: SesFeedback): string | null {
  switch (feedback.eventType) {
    case 'DELIVERY_DELAY':
      return safeCode('DELIVERY_DELAY', feedback.delayType);
    case 'BOUNCE':
      return safeCode('BOUNCE', feedback.bounceType, feedback.bounceSubType);
    case 'COMPLAINT':
      return safeCode(
        'COMPLAINT',
        feedback.complaintSubType,
        feedback.complaintFeedbackType,
      );
    case 'REJECT':
      return 'SES_REJECTED';
    case 'RENDERING_FAILURE':
      return 'RENDERING_FAILURE';
    default:
      return null;
  }
}

export function eventSubtype(feedback: SesFeedback): string | null {
  switch (feedback.eventType) {
    case 'DELIVERY_DELAY':
      return safeCode(feedback.delayType);
    case 'BOUNCE':
      return safeCode(feedback.bounceType, feedback.bounceSubType);
    case 'COMPLAINT':
      return (
        safeCode(feedback.complaintSubType, feedback.complaintFeedbackType) ||
        null
      );
    case 'REJECT':
      return 'SES_REJECTED';
    case 'RENDERING_FAILURE':
      return 'RENDERING_FAILURE';
    default:
      return null;
  }
}

function safeCode(...parts: Array<string | undefined>): string {
  return parts
    .filter((part): part is string => Boolean(part))
    .map((part) => part.replace(/[^A-Za-z0-9]+/g, '_').toUpperCase())
    .join('_')
    .slice(0, 100);
}

export function feedbackId(feedback: SesFeedback): string | null {
  return feedback.eventType === 'BOUNCE' || feedback.eventType === 'COMPLAINT'
    ? feedback.feedbackId
    : null;
}

export function toEventType(feedback: SesFeedback): EmailDeliveryEventType {
  return EmailDeliveryEventType[feedback.eventType];
}
