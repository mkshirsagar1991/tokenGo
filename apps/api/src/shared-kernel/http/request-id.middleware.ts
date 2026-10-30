import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from '../request-context';

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** Correlation ID (docs §O.1): accept a well-formed inbound `X-Request-Id`, else mint one; echo it back. */
export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const inbound = req.header('x-request-id');
  const requestId = inbound && SAFE_ID.test(inbound) ? inbound : randomUUID();
  res.setHeader('X-Request-Id', requestId);
  requestContext.run({ requestId }, () => next());
}
