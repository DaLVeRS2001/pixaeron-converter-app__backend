import { BadRequestException } from '@nestjs/common';

import {
  CURRENT_LEGAL_CONSENT_VERSION,
  LEGAL_CONSENT_REQUIRED_ERROR,
} from '../constants/legal-consent.constants';

export function assertCurrentLegalConsent(
  accepted: boolean | undefined,
  version: string | undefined,
): void {
  if (accepted !== true || version !== CURRENT_LEGAL_CONSENT_VERSION) {
    throw new BadRequestException(LEGAL_CONSENT_REQUIRED_ERROR);
  }
}
