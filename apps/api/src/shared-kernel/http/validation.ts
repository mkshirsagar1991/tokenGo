import { ValidationError, ValidationPipe } from '@nestjs/common';
import { ValidationFailedError } from '../errors';

function flatten(errors: ValidationError[], parent = ''): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const e of errors) {
    const path = parent ? `${parent}.${e.property}` : e.property;
    if (e.constraints) out[path] = Object.values(e.constraints);
    if (e.children?.length) Object.assign(out, flatten(e.children, path));
  }
  return out;
}

/**
 * Strict input validation (requirements §23/§24): unknown properties are REJECTED (not silently
 * stripped) so a client can never smuggle `status`, `balance`, `commission` etc. into a command.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: false },
    exceptionFactory: (errors) => new ValidationFailedError('Request validation failed', { fields: flatten(errors) }),
  });
}
