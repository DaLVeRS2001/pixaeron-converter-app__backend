import { Controller, Get, Header } from '@nestjs/common';

import { JWKS_CACHE_CONTROL } from './constants/access-token.constants';
import { AccessTokenKeyService } from './services/access-token-key.service';

@Controller('.well-known')
export class JwksController {
  constructor(private readonly accessTokenKeys: AccessTokenKeyService) {}

  @Get('jwks.json')
  @Header('Cache-Control', JWKS_CACHE_CONTROL)
  getJwks() {
    return { keys: this.accessTokenKeys.getJwks() };
  }
}
