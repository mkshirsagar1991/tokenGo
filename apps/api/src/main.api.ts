import 'reflect-metadata';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { createApp } from './app.factory';
import { APP_CONFIG, AppConfig, LOGGER } from './shared-kernel';
import type { Logger } from 'pino';

async function bootstrap(): Promise<void> {
  const app = await createApp();
  const config = app.get<AppConfig>(APP_CONFIG);
  const logger = app.get<Logger>(LOGGER);

  if (!config.isProduction) {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('TokenGo API').setVersion('1').addBearerAuth().build(),
    );
    SwaggerModule.setup('api/docs', app, doc);
  }

  app.enableShutdownHooks();
  await app.listen(config.port);
  logger.info({ port: config.port, env: config.env }, 'api listening');
}

bootstrap().catch((err) => {
  // Fail fast and loudly (bad config, unreachable DB, ...) — never start half-configured.
  console.error('Fatal start-up error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
