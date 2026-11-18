import express, { type Express } from 'express';
import swaggerUi from 'swagger-ui-express';
import type { CreateValidationUseCase } from './application/use-cases/create-validation';
import type { GetValidationUseCase } from './application/use-cases/get-validation';
import type { HealthProbe } from './domain/ports';
import type { Logger } from './shared/logger';
import { createValidationController } from './presentation/controllers/validation.controller';
import { createAuthMiddleware } from './presentation/middlewares/auth';
import {
  createErrorHandler,
  notFoundHandler,
  requestId,
} from './presentation/middlewares/error-handler';
import {
  createJsonParser,
  createRateLimiter,
  securityHeaders,
  type SecurityOptions,
} from './presentation/middlewares/security';
import { createHealthRouter } from './presentation/routes/health.routes';
import { createValidationRouter } from './presentation/routes/validation.routes';
import { openApiSpec } from './presentation/swagger/openapi';

export interface AppDeps {
  createValidation: CreateValidationUseCase;
  getValidation: GetValidationUseCase;
  healthProbes: HealthProbe[];
  jwtSecret: string;
  security: SecurityOptions;
  logger: Logger;
}

/**
 * Construye la aplicación Express sin abrir puertos ni conexiones:
 * así los tests pueden montarla con fakes y `server.ts` decide cuándo escuchar.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(securityHeaders);

  // Públicos y sin rate limit: los usan los healthchecks de Docker.
  app.use(createHealthRouter(deps.healthProbes));

  app.use(createRateLimiter(deps.security));

  app.get('/docs.json', (_req, res) => {
    res.json(openApiSpec);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

  app.use(createJsonParser(deps.security.bodyLimit));

  const controller = createValidationController({
    createValidation: deps.createValidation,
    getValidation: deps.getValidation,
  });
  app.use('/validations', createValidationRouter(controller, createAuthMiddleware(deps.jwtSecret)));

  app.use(notFoundHandler);
  app.use(createErrorHandler(deps.logger));

  return app;
}
