import type { RequestHandler } from 'express';
import jwt from 'jsonwebtoken';
import { UnauthorizedError } from '../../domain/errors';

/** Verifica `Authorization: Bearer <jwt>` (HS256 fijado para evitar confusión de algoritmos). */
export function createAuthMiddleware(secret: string): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization;
    const match = header ? /^Bearer\s+(\S+)$/i.exec(header) : null;
    if (!match?.[1]) return next(new UnauthorizedError('Missing or malformed Authorization header'));

    try {
      const claims = jwt.verify(match[1], secret, { algorithms: ['HS256'] });
      if (typeof claims === 'string') return next(new UnauthorizedError('Invalid token'));
      req.auth = claims;
      return next();
    } catch (err) {
      const expired = err instanceof jwt.TokenExpiredError;
      return next(new UnauthorizedError(expired ? 'Token expired' : 'Invalid token'));
    }
  };
}
