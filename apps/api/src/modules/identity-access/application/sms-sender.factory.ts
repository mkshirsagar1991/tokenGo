import type { Logger } from 'pino';
import type { AppConfig } from '../../../shared-kernel';
import { normalizePhone } from '../domain/phone';
import { Msg91SmsSender } from './msg91-sms-sender';
import { ConsoleSmsSender, DisabledSmsSender, LogOnlyRoutingSmsSender, SmsSender } from './sms-sender';
import { WhatsAppSmsSender } from './whatsapp-sms-sender';

/** Chooses the SMS sender from configuration (validated in shared-kernel/config.ts; a misconfiguration already failed at start-up). */
export function buildSmsSender(config: AppConfig, logger: Logger): SmsSender {
  const consoleSender = new ConsoleSmsSender(logger);
  let real: SmsSender;
  switch (config.smsProvider) {
    case 'console':
      return consoleSender;
    case 'msg91':
      if (!config.msg91) throw new Error('SMS_PROVIDER=msg91 without MSG91 settings'); // unreachable: config validation guarantees them
      real = new Msg91SmsSender(config.msg91, logger);
      break;
    case 'whatsapp':
      if (!config.whatsapp) throw new Error('SMS_PROVIDER=whatsapp without WhatsApp settings'); // unreachable: config validation guarantees them
      real = new WhatsAppSmsSender(config.whatsapp, logger);
      break;
    default:
      return new DisabledSmsSender();
  }

  const logOnly = new Set(
    config.smsLogOnlyPhones.map((raw) => {
      const e164 = normalizePhone(raw);
      if (!e164) throw new Error(`SMS_LOG_ONLY_PHONES contains "${raw}", which is not a valid mobile number`);
      return e164;
    }),
  );
  return logOnly.size > 0 ? new LogOnlyRoutingSmsSender(real, consoleSender, logOnly) : real;
}
