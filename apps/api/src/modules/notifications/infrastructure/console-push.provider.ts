import type { Logger } from 'pino';
import { PushMessage, PushProvider, PushResult } from './push-provider';

/**
 * Development/test push: logs what WOULD be sent (the token is masked) and records it so tests can assert on it. A token starting
 * with `invalid-` simulates a device that no longer exists, and `flaky-` a transient failure that succeeds on the next try.
 */
export class ConsolePushProvider extends PushProvider {
  readonly name = 'console' as const;
  readonly enabled = true;
  readonly sent: PushMessage[] = [];
  private readonly flakySeen = new Set<string>();

  constructor(private readonly logger?: Logger) {
    super();
  }

  async send(message: PushMessage): Promise<PushResult> {
    if (message.token.startsWith('invalid-')) return { kind: 'INVALID_TOKEN' };
    if (message.token.startsWith('flaky-') && !this.flakySeen.has(message.token)) {
      this.flakySeen.add(message.token);
      return { kind: 'RETRY', reason: 'simulated transient failure' };
    }
    this.sent.push(message);
    this.logger?.warn({ token: `…${message.token.slice(-4)}`, title: message.title }, '[DEV PUSH] would send a push notification');
    return { kind: 'SENT', messageId: `console-${this.sent.length}` };
  }
}
