export interface PushMessage {
  token: string;
  title: string;
  body: string;
  /** String values only (the push transports require it). Ids for deep links, never personal data. */
  data: Record<string, string>;
}

/**
 * The outcome of ONE send. The delivery service acts on the KIND, never on provider-specific details:
 *  - SENT: the provider accepted it.
 *  - INVALID_TOKEN: the device is gone (app uninstalled / token rotated): stop using this token.
 *  - RETRY: a transient problem (timeout, 5xx, throttling, expired credentials): try again later.
 *  - REJECTED: the provider refused this message permanently; retrying would not help.
 */
export type PushResult = { kind: 'SENT'; messageId: string } | { kind: 'INVALID_TOKEN' } | { kind: 'RETRY'; reason: string } | { kind: 'REJECTED'; reason: string };

/** The ONE place that talks to a push network. Implementations: console (dev/test), FCM, disabled. */
export abstract class PushProvider {
  abstract readonly name: 'console' | 'fcm' | 'disabled';
  /** false = nothing is sent and no delivery rows are created (the in-app list still works). */
  abstract readonly enabled: boolean;
  abstract send(message: PushMessage): Promise<PushResult>;
}

export class DisabledPushProvider extends PushProvider {
  readonly name = 'disabled' as const;
  readonly enabled = false;

  async send(): Promise<PushResult> {
    return { kind: 'REJECTED', reason: 'push is disabled' };
  }
}
