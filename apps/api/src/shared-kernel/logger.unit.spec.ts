import { Writable } from 'node:stream';
import { createLogger } from './logger';
import { requestContext } from './request-context';

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

describe('logger redaction (requirements §24: never log OTPs, tokens, secrets, PII)', () => {
  it('redacts sensitive fields at the top level and one level deep', () => {
    const { lines, stream } = capture();
    const log = createLogger('info', stream);
    log.info(
      {
        otp: '123456',
        phone: '+919876543210',
        refresh_token: 'rt-secret',
        authkey: 'msg91-key-secret',
        req: { headers: { authorization: 'Bearer abc.def.ghi', cookie: 'sid=1', authkey: 'msg91-header-secret' } },
        body: { password: 'hunter2', pin: '4321', lat: 18.52, lng: 73.85, safe: 'visible' },
      },
      'test',
    );
    const out = lines.join('');
    for (const secret of ['123456', '+919876543210', 'rt-secret', 'msg91-key-secret', 'msg91-header-secret', 'abc.def.ghi', 'sid=1', 'hunter2', '4321', '18.52', '73.85']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('visible');
    expect(out).toContain('[REDACTED]');
  });

  it('attaches the request id from the async context', () => {
    const { lines, stream } = capture();
    const log = createLogger('info', stream);
    requestContext.run({ requestId: 'req-12345678', actorId: 'actor-1' }, () => log.info('inside'));
    const parsed = JSON.parse(lines.join(''));
    expect(parsed.request_id).toBe('req-12345678');
    expect(parsed.actor_id).toBe('actor-1');
  });
});
