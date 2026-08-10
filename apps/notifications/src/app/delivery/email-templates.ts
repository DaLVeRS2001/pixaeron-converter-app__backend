import { SecurityEmailPurpose } from '@pixaeron/notifications-contract';

export type SecurityEmailContent = {
  subject: string;
  text: string;
  html: string;
};

const CURRENT_CONTENT_VERSION = 1;

export function renderSecurityEmail(
  purpose: SecurityEmailPurpose,
  token: string,
  frontendOrigin: string,
  contentVersion: number,
): SecurityEmailContent {
  if (contentVersion !== CURRENT_CONTENT_VERSION) {
    throw new Error('Unsupported security email content version');
  }

  switch (purpose) {
    case SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_EMAIL_VERIFICATION:
      return renderEmailVerification(token, frontendOrigin);
    case SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_PASSWORD_RESET:
      return renderPasswordReset(token, frontendOrigin);
    default:
      throw new Error('Unsupported security email purpose');
  }
}

function renderEmailVerification(
  token: string,
  frontendOrigin: string,
): SecurityEmailContent {
  const link = createTokenLink(frontendOrigin, '/verify-email', token);

  return {
    subject: 'Verify your Pixaeron email',
    text: `Verify your Pixaeron email by opening this link: ${link}\n\nThis link expires in 24 hours. If you did not create this account, do not open the link; ignore this email.`,
    html: `<p>Verify your Pixaeron email:</p><p><a href="${link}">Verify email</a></p><p>This link expires in 24 hours.</p><p>If you did not create this account, do not open the link; ignore this email.</p>`,
  };
}

function renderPasswordReset(
  token: string,
  frontendOrigin: string,
): SecurityEmailContent {
  const link = createTokenLink(frontendOrigin, '/reset-password', token);

  return {
    subject: 'Reset your Pixaeron password',
    text: `Reset your Pixaeron password by opening this link: ${link}\n\nThis link expires in 15 minutes. If you did not request it, ignore this email.`,
    html: `<p>Reset your Pixaeron password:</p><p><a href="${link}">Reset password</a></p><p>This link expires in 15 minutes.</p><p>If you did not request it, ignore this email.</p>`,
  };
}

function createTokenLink(
  frontendOrigin: string,
  path: string,
  token: string,
): string {
  return `${frontendOrigin.replace(/\/$/, '')}${path}#token=${encodeURIComponent(token)}`;
}
