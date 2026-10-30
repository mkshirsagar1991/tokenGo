/**
 * Domain/application error model. Every error carries a stable machine code (clients branch on
 * `code`, never on the message) and an HTTP status; the filter renders RFC 7807 problem+json.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationFailedError extends DomainError {
  constructor(message = 'Request validation failed', details?: Record<string, unknown>) {
    super('VALIDATION_FAILED', message, 422, details);
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(message = 'Authentication required', code = 'UNAUTHENTICATED') {
    super(code, message, 401);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'You do not have permission to perform this action', code = 'FORBIDDEN') {
    super(code, message, 403);
  }
}

/** Also used when an object exists but the actor may not know it exists (IDOR hardening). */
export class NotFoundError extends DomainError {
  constructor(resource = 'Resource', code = 'NOT_FOUND') {
    super(code, `${resource} not found`, 404);
  }
}

export class ConflictError extends DomainError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 409, details);
  }
}

export class TooManyRequestsError extends DomainError {
  constructor(message = 'Too many requests', retryAfterSeconds?: number) {
    super('RATE_LIMITED', message, 429, retryAfterSeconds ? { retry_after_seconds: retryAfterSeconds } : undefined);
  }
}
