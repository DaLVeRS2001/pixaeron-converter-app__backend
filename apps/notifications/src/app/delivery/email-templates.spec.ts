import { SecurityEmailPurpose } from '@pixaeron/notifications-contract';

import { renderSecurityEmail } from './email-templates';

describe('renderSecurityEmail', () => {
  it.each([
    [
      SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_EMAIL_VERIFICATION,
      '/verify-email#token=secret%20token',
      'Verify your Pixaeron email',
    ],
    [
      SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_PASSWORD_RESET,
      '/reset-password#token=secret%20token',
      'Reset your Pixaeron password',
    ],
  ])('renders the supported purpose', (purpose, path, subject) => {
    const content = renderSecurityEmail(
      purpose,
      'secret token',
      'https://pixaeron.com/',
      1,
    );

    expect(content.subject).toBe(subject);
    expect(content.text).toContain(`https://pixaeron.com${path}`);
    expect(content.html).toContain(`href="https://pixaeron.com${path}"`);
  });

  it('rejects unsupported content versions', () => {
    expect(() =>
      renderSecurityEmail(
        SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_PASSWORD_RESET,
        'token',
        'https://pixaeron.com',
        2,
      ),
    ).toThrow('Unsupported security email content version');
  });

  it('rejects an unspecified purpose', () => {
    expect(() =>
      renderSecurityEmail(
        SecurityEmailPurpose.SECURITY_EMAIL_PURPOSE_UNSPECIFIED,
        'token',
        'https://pixaeron.com',
        1,
      ),
    ).toThrow('Unsupported security email purpose');
  });
});
