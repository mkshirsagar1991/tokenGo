import { Global, Module } from '@nestjs/common';
import { DiscoveryModule } from '@nestjs/core';
import { Clock, SystemClock } from './clock';
import { APP_CONFIG, AppConfig, loadConfig } from './config';
import { FieldCipher } from './crypto';
import { DatabaseService, UnitOfWork } from './database';
import { DeletionGuardRegistry } from './deletion-guards';
import { ProblemDetailsFilter } from './http/problem-details.filter';
import { createLogger } from './logger';
import { OutboxDispatcher } from './outbox/outbox.dispatcher';
import { OutboxService } from './outbox/outbox.service';
import { LocalObjectStorage, OBJECT_STORAGE, ObjectStorage, S3ObjectStorage } from './storage/object-storage';
import { S3Client } from '@aws-sdk/client-s3';
import { FIELD_CIPHER, LOGGER, PII_HASH_KEY } from './tokens';

@Global()
@Module({
  imports: [DiscoveryModule],
  providers: [
    { provide: APP_CONFIG, useFactory: () => loadConfig() },
    { provide: LOGGER, inject: [APP_CONFIG], useFactory: (c: AppConfig) => createLogger(c.logLevel) },
    { provide: FIELD_CIPHER, inject: [APP_CONFIG], useFactory: (c: AppConfig) => new FieldCipher(c.piiEncryptionKey) },
    { provide: PII_HASH_KEY, inject: [APP_CONFIG], useFactory: (c: AppConfig) => c.piiHashKey },
    { provide: Clock, useClass: SystemClock },
    {
      // The ONE place that decides where uploaded files live. Production configuration cannot select the local disk.
      provide: OBJECT_STORAGE,
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig): ObjectStorage =>
        c.storage.driver === 's3' ? new S3ObjectStorage(c.storage.bucket!, new S3Client({ region: c.storage.region })) : new LocalObjectStorage(c.storage.localDir),
    },
    DatabaseService,
    UnitOfWork,
    DeletionGuardRegistry,
    ProblemDetailsFilter,
    OutboxService,
    OutboxDispatcher,
  ],
  exports: [
    OBJECT_STORAGE,
    APP_CONFIG,
    LOGGER,
    FIELD_CIPHER,
    PII_HASH_KEY,
    Clock,
    DatabaseService,
    UnitOfWork,
    DeletionGuardRegistry,
    ProblemDetailsFilter,
    OutboxService,
    OutboxDispatcher,
  ],
})
export class SharedKernelModule {}
