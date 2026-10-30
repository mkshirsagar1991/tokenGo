import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Inject } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { Logger } from 'pino';
import { DomainError } from '../errors';
import { currentRequestId } from '../request-context';
import { LOGGER } from '../tokens';

interface Problem {
  type: string;
  title: string;
  status: number;
  code: string;
  detail: string;
  request_id?: string;
  errors?: unknown;
  retry_after_seconds?: number;
}

/**
 * Renders every failure as RFC 7807 `application/problem+json` with a stable machine `code`
 * (docs §O.1). Unknown errors never leak internals: the client gets a generic 500 + request id,
 * the details go to the structured log.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();

    const problem = this.toProblem(exception);
    if (problem.status >= 500) {
      this.logger.error({ err: exception, path: req.path, method: req.method }, 'unhandled error');
    }
    if (problem.retry_after_seconds) res.setHeader('Retry-After', String(problem.retry_after_seconds));
    res.status(problem.status).type('application/problem+json').json(problem);
  }

  private toProblem(exception: unknown): Problem {
    const request_id = currentRequestId();

    if (exception instanceof DomainError) {
      const { retry_after_seconds, ...rest } = (exception.details ?? {}) as {
        retry_after_seconds?: number;
      } & Record<string, unknown>;
      return {
        type: `urn:tokengo:problem:${exception.code.toLowerCase()}`,
        title: exception.name,
        status: exception.status,
        code: exception.code,
        detail: exception.message,
        request_id,
        ...(Object.keys(rest).length ? { errors: rest } : {}),
        ...(retry_after_seconds ? { retry_after_seconds } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      return {
        type: 'urn:tokengo:problem:http_error',
        title: exception.name,
        status,
        code: status === 404 ? 'NOT_FOUND' : status === 401 ? 'UNAUTHENTICATED' : `HTTP_${status}`,
        detail: status < 500 ? exception.message : 'Internal server error',
        request_id,
      };
    }

    return {
      type: 'urn:tokengo:problem:internal_error',
      title: 'InternalServerError',
      status: 500,
      code: 'INTERNAL_ERROR',
      detail: 'Internal server error',
      request_id,
    };
  }
}
