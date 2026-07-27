import { BadRequestException } from '@nestjs/common';

import { CURRENT_LEGAL_CONSENT_VERSION } from '../constants/legal-consent.constants';
import { assertCurrentLegalConsent } from './assert-current-legal-consent';

describe('assertCurrentLegalConsent', () => {
  it.each([
    { accepted: undefined, version: undefined },
    { accepted: false, version: CURRENT_LEGAL_CONSENT_VERSION },
    { accepted: true, version: '2026-07-25' },
  ])('rejects missing or stale consent', ({ accepted, version }) => {
    expect(() => assertCurrentLegalConsent(accepted, version)).toThrow(
      BadRequestException,
    );

    try {
      assertCurrentLegalConsent(accepted, version);
    } catch (error) {
      expect(error).toMatchObject({
        response: expect.objectContaining({
          code: 'LEGAL_CONSENT_REQUIRED',
          action: 'accept_legal_terms',
        }),
      });
    }
  });

  it('accepts the exact current consent version', () => {
    expect(() =>
      assertCurrentLegalConsent(true, CURRENT_LEGAL_CONSENT_VERSION),
    ).not.toThrow();
  });
});
