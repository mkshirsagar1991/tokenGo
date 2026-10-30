import { INestApplication, VersioningType } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { ProblemDetailsFilter, createValidationPipe, requestIdMiddleware } from './shared-kernel';

/** Applies every cross-cutting HTTP concern. Shared by production bootstrap and the integration tests. */
export function configureApp(app: INestApplication): void {
  const express = app as NestExpressApplication;
  express.set('trust proxy', 1); // behind the ALB: req.ip must be the client address, not the proxy
  express.disable('x-powered-by');

  app.use(requestIdMiddleware);
  app.use(
    helmet({
      // API only serves JSON; lock everything down (admin portal sets its own CSP).
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.setGlobalPrefix('api');
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.useGlobalPipes(createValidationPipe());
  app.useGlobalFilters(app.get(ProblemDetailsFilter));
}

export async function createApp(): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule, { bufferLogs: false, logger: ['error', 'warn'], rawBody: true });
  configureApp(app);
  return app;
}
