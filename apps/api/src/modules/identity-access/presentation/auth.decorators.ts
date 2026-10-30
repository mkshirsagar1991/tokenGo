// The decorators are pure metadata and live in the shared kernel so ANY module (including leaf modules such
// as the ledger) can declare its routes' requirements without depending on identity. The enforcing guard
// (AuthGuard) lives here in identity-access.
export { CurrentActor, IS_PUBLIC, PLATFORM_PERMISSION, Public, RequirePlatformPermission } from '../../../shared-kernel';
export type { Actor } from '../../../shared-kernel';
