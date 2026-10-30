import { Controller, Get, Inject } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { APP_CONFIG, AppConfig, Clock, Money } from '../../../shared-kernel';
import { Public } from '../../identity-access';
import { SettingsService } from '../application/settings.service';

/**
 * What the mobile apps need before anyone signs in: the public settings (support contacts, minimum app versions, feature
 * flags, top-up presets) and an HONEST statement of the payment mode, so a test environment can never be mistaken for a
 * live one. Contains no secrets and nothing user-specific.
 */
@ApiTags('platform')
@Controller({ path: 'app-config', version: '1' })
export class AppConfigController {
  constructor(
    private readonly settings: SettingsService,
    private readonly clock: Clock,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get()
  async get() {
    return {
      data: {
        environment: this.config.env,
        server_time: this.clock.now().toISOString(),
        payments: {
          provider: this.config.payments.provider,
          // Real money is refused at startup, so any enabled provider is a sandbox/test provider.
          test_mode: this.config.payments.provider !== 'disabled',
          topup_min: Money.of(this.config.payments.topupMinMinor, 'INR').toJSON(),
          topup_max: Money.of(this.config.payments.topupMaxMinor, 'INR').toJSON(),
        },
        settings: await this.settings.publicValues(),
      },
    };
  }
}
