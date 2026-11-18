import express, { type RequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { sendError } from './error-handler';

export interface SecurityOptions {
  bodyLimit: string;
  rateLimitWindowMs: number;
  rateLimitMax: number;
}

/**
 * Cabeceras de seguridad (helmet). Se desactiva `upgrade-insecure-requests` del CSP:
 * forzaría https en recursos de Swagger UI al servir por http (local/Docker).
 */
export const securityHeaders: RequestHandler = helmet({
  contentSecurityPolicy: { useDefaults: true, directives: { 'upgrade-insecure-requests': null } },
});

/** Parser JSON con límite de tamaño; solo acepta application/json. */
export const createJsonParser = (bodyLimit: string): RequestHandler =>
  express.json({ limit: bodyLimit, type: 'application/json' });

/** Límite de peticiones por IP en una ventana de tiempo. */
export const createRateLimiter = (opts: SecurityOptions): RequestHandler =>
  rateLimit({
    windowMs: opts.rateLimitWindowMs,
    limit: opts.rateLimitMax,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => sendError(res, 429, 'RATE_LIMITED', 'Too many requests, please retry later'),
  });
