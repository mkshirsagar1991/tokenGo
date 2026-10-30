import { Module } from '@nestjs/common';
import { APP_CONFIG, AppConfig, LOGGER } from '../../shared-kernel';
import type { Logger } from 'pino';
import { BookingModule } from '../booking';
import { IdentityAccessModule } from '../identity-access';
import { ProviderManagementModule } from '../provider-management';
import { DeliveryService } from './application/delivery.service';
import { NotificationDeliverConsumer, NotificationEventConsumer, NotificationUserDeletedConsumer } from './application/notification.consumers';
import { NotificationService } from './application/notification.service';
import { ConsolePushProvider } from './infrastructure/console-push.provider';
import { FcmPushProvider } from './infrastructure/fcm-push.provider';
import { DisabledPushProvider, PushProvider } from './infrastructure/push-provider';
import { NotificationsAdminController } from './presentation/notifications-admin.controller';
import { NotificationsController } from './presentation/notifications.controller';

@Module({
  imports: [IdentityAccessModule, BookingModule, ProviderManagementModule],
  controllers: [NotificationsController, NotificationsAdminController],
  providers: [
    {
      // The ONE place that decides how pushes leave the system. Production cannot select the console provider.
      provide: PushProvider,
      inject: [APP_CONFIG, LOGGER],
      useFactory: (config: AppConfig, logger: Logger): PushProvider => {
        if (config.push.provider === 'fcm' && config.push.fcm) return new FcmPushProvider(config.push.fcm);
        if (config.push.provider === 'console') return new ConsolePushProvider(logger);
        return new DisabledPushProvider();
      },
    },
    NotificationService,
    DeliveryService,
    NotificationEventConsumer,
    NotificationDeliverConsumer,
    NotificationUserDeletedConsumer,
  ],
  exports: [NotificationService],
})
export class NotificationsModule {}
