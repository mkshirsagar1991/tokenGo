import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { AdminAuthService } from '../modules/identity-access';

/**
 * Controlled, audited bootstrap of a privileged account — there is deliberately no public API for this.
 *
 *   ADMIN_PHONE=9876543210 ADMIN_EMAIL=you@company.com ADMIN_PASSWORD='long passphrase here' \
 *   [ADMIN_ROLES=PLATFORM_ADMIN,SUPPORT_OPERATOR] pnpm --filter @tokengo/api admin:create
 *
 * The password is read from the environment only (never a CLI argument, so it stays out of shell
 * history and process listings). The first sign-in forces enrolment of an authenticator app.
 */
async function main(): Promise<void> {
  const { ADMIN_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_ROLES } = process.env;
  if (!ADMIN_PHONE || !ADMIN_EMAIL || !ADMIN_PASSWORD) {
    console.error('Required environment: ADMIN_PHONE, ADMIN_EMAIL, ADMIN_PASSWORD (optional: ADMIN_ROLES, comma-separated).');
    process.exit(2);
  }
  const roleCodes = (ADMIN_ROLES ?? 'PLATFORM_ADMIN').split(',').map((r) => r.trim()).filter(Boolean);

  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error'] });
  try {
    const { userId } = await app.get(AdminAuthService).createAdmin({
      phone: ADMIN_PHONE,
      email: ADMIN_EMAIL,
      password: ADMIN_PASSWORD,
      roleCodes,
    });
    console.log(`Created administrator ${userId} with roles: ${roleCodes.join(', ')}`);
    console.log('Next: POST /api/v1/auth/admin/login — you will be asked to enrol an authenticator app on first sign-in.');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
