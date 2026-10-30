import { Controller, HttpCode, Param, Post, RawBodyRequest, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';
import { Public } from '../../../shared-kernel';
import { WebhookService } from '../application/webhook.service';

/**
 * Public by necessity (the provider is not a logged-in user) — its authentication is the signature, checked over the raw
 * request bytes before anything else happens. `rawBody` is enabled at application bootstrap for exactly this.
 */
@ApiExcludeController()
@Controller({ path: 'payments/webhooks', version: '1' })
export class WebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  @Public()
  @Post(':provider')
  @HttpCode(200)
  async receive(@Param('provider') provider: string, @Req() req: RawBodyRequest<Request>) {
    return { status: await this.webhooks.receive(provider, req.rawBody, req.headers) };
  }
}
