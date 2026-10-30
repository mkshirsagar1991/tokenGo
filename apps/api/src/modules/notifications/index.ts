// Public API of the notifications module. Other modules publish outbox events; this module turns them into notifications.
export { NotificationsModule } from './notifications.module';
export { NotificationService } from './application/notification.service';
export type { NotificationView } from './application/notification.service';
export { PushProvider } from './infrastructure/push-provider';
export type { PushMessage, PushResult } from './infrastructure/push-provider';
export { ConsolePushProvider } from './infrastructure/console-push.provider';
export { FcmPushProvider } from './infrastructure/fcm-push.provider';
export type { Draft, Audience, Category } from './domain/templates';
