import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface EmailDeliveryReceipt {
  provider: 'ses';
  messageId: string;
}

@Injectable()
export class TransactionalEmailService {
  private readonly enabled: boolean;
  private readonly client?: SESv2Client;
  private readonly frontendUrl?: string;
  private readonly fromEmailAddress?: string;

  constructor(private readonly configService: ConfigService) {
    this.enabled = this.configService.get('EMAIL_DELIVERY_ENABLED') === 'true';

    if (this.enabled) {
      this.client = new SESv2Client({
        region: this.configService.getOrThrow('AWS_REGION'),
      });
      this.frontendUrl = this.configService
        .getOrThrow<string>('FRONTEND_URL')
        .replace(/\/$/, '');
      this.fromEmailAddress =
        this.configService.getOrThrow<string>('SES_FROM_EMAIL');
    }
  }

  assertAvailable(): void {
    if (this.enabled && this.client) return;

    throw new ServiceUnavailableException({
      code: 'EMAIL_DELIVERY_UNAVAILABLE',
      message: 'Email delivery is temporarily unavailable',
    });
  }

  sendEmailVerification(
    to: string,
    token: string,
  ): Promise<EmailDeliveryReceipt> {
    this.assertAvailable();
    const link = this.createFragmentLink('/verify-email', token);

    return this.send({
      to,
      subject: 'Verify your Pixaeron email',
      text: `Verify your Pixaeron email by opening this link: ${link}\n\nThis link expires in 24 hours. If you did not create this account, do not open the link; ignore this email.`,
      html: `<p>Verify your Pixaeron email:</p><p><a href="${link}">Verify email</a></p><p>This link expires in 24 hours.</p><p>If you did not create this account, do not open the link; ignore this email.</p>`,
    });
  }

  sendPasswordReset(to: string, token: string): Promise<EmailDeliveryReceipt> {
    this.assertAvailable();
    const link = this.createFragmentLink('/reset-password', token);

    return this.send({
      to,
      subject: 'Reset your Pixaeron password',
      text: `Reset your Pixaeron password by opening this link: ${link}\n\nThis link expires in 15 minutes. If you did not request it, ignore this email.`,
      html: `<p>Reset your Pixaeron password:</p><p><a href="${link}">Reset password</a></p><p>This link expires in 15 minutes. If you did not request it, ignore this email.</p>`,
    });
  }

  private createFragmentLink(path: string, token: string): string {
    return `${this.frontendUrl}${path}#token=${encodeURIComponent(token)}`;
  }

  private async send({
    to,
    subject,
    text,
    html,
  }: {
    to: string;
    subject: string;
    text: string;
    html: string;
  }): Promise<EmailDeliveryReceipt> {
    if (!this.client) {
      throw new ServiceUnavailableException({
        code: 'EMAIL_DELIVERY_UNAVAILABLE',
        message: 'Email delivery is temporarily unavailable',
      });
    }

    const result = await this.client.send(
      new SendEmailCommand({
        FromEmailAddress: this.fromEmailAddress,
        Destination: { ToAddresses: [to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: 'UTF-8' },
            Body: {
              Text: { Data: text, Charset: 'UTF-8' },
              Html: { Data: html, Charset: 'UTF-8' },
            },
          },
        },
      }),
    );

    if (!result.MessageId) {
      throw new Error('SES did not return a message ID');
    }

    return { provider: 'ses', messageId: result.MessageId };
  }
}
