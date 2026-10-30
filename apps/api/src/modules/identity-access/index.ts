// Public API of identity-access. Other modules import ONLY from here (enforced by dependency-cruiser).
export { IdentityAccessModule } from './identity-access.module';
export { AuthorizationService } from './application/authorization.service';
export { AdminAuthService } from './application/admin-auth.service';
export { hotp, totpStep, base32Decode } from './domain/totp';
export type { AuthzScope } from './application/authorization.service';
export { PhoneHasher } from './application/phone-hasher';
export { SmsSender } from './application/sms-sender';
export { Public, RequirePlatformPermission, CurrentActor } from './presentation/auth.decorators';
export type { Actor } from './presentation/auth.decorators';
export { normalizePhone, maskPhone } from './domain/phone';
