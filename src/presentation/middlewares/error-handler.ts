import { randomUUID } from 'node:crypto';
import type { ErrorRequestHandler, RequestHandler, Response } from 'express';
import { DomainError, type DomainErrorCode, type ErrorDetail } from '../../domain/errors';
import { errorMeta, type Logger } from '../../shared/logger';

const STATUS_BY_CODE: Record<DomainErrorCode, number> = {
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  EXTERNAL_SERVICE_ERROR: 502,
  REPOSITORY_ERROR: 503,
  INTERNAL_ERROR: 500,
};

/** Mensaje genérico para errores cuyo detalle no debe llegar al cliente. */
const PUBLIC_MESSAGE: Partial<Record<DomainErrorCode, string>> = {
  REPOSITORY_ERROR: 'Service temporarily unavailable',
  INTERNAL_ERROR: 'Internal server error',
};

const SAFE_REQUEST_ID = /^[\w.-]{1,64}$/;

/** Asigna un request id (reutiliza `x-request-id` si es seguro) y lo devuelve en la respuesta. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.headers['x-request-id'];
  const value = typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming) ? incoming : randomUUID();
  req.requestId = value;
  res.setHeader('x-request-id', value);
  next();
};

/** Envelope único de error: { error: { code, message, details?, requestId } }. */
export function sendError(
  res: Response,
  status: number,
  code: string,
  message: string,
  details?: ErrorDetail[],
): void {
  res.status(status).json({
    error: {
      code,
      message,
      ...(details ? { details } : {}),
      requestId: res.getHeader('x-request-id'),
    },
  });
}

export const notFoundHandler: RequestHandler = (req, res) => {
  sendError(res, 404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`);
};

export function createErrorHandler(logger: Logger): ErrorRequestHandler {
  // Express identifica los error handlers por aridad (4 argumentos).
  return (err, req, res, _next) => {
    if (res.headersSent) {
      logger.error('error after headers were sent', { requestId: req.requestId, ...errorMeta(err) });
      res.end();
      return;
    }

    if (err instanceof DomainError) {
      const status = STATUS_BY_CODE[err.code];
      if (status >= 500) {
        logger.error('request failed', {
          requestId: req.requestId,
          code: err.code,
          ...errorMeta(err),
          ...errorMeta((err as { cause?: unknown }).cause),
        });
      }
      return sendError(res, status, err.code, PUBLIC_MESSAGE[err.code] ?? err.message, err.details);
    }

    // Errores del body parser de Express.
    const type = (err as { type?: string } | null)?.type;
    if (type === 'entity.too.large') {
      return sendError(res, 413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
    }
    if (type === 'entity.parse.failed') {
      return sendError(res, 400, 'INVALID_JSON', 'Request body is not valid JSON');
    }

    logger.error('unhandled error', { requestId: req.requestId, ...errorMeta(err) });
    return sendError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
  };
}
