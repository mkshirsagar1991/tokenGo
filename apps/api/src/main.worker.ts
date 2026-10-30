import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker/worker.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { logger: ['error', 'warn'] });
  app.enableShutdownHooks(); // SIGTERM from ECS => finish the in-flight batch, then exit
}

bootstrap().catch((err) => {
  console.error('Fatal worker start-up error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
