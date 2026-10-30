// Public API of the platform module (health, settings, audit read-side, reports). Depends on shared-kernel, audit, identity-access.
export { PlatformModule } from './platform.module';
export { SettingsService } from './application/settings.service';
export type { SettingView } from './application/settings.service';
export { SETTINGS, validateSetting } from './domain/settings-registry';
