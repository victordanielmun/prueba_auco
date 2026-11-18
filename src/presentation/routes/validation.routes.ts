import { Router, type RequestHandler } from 'express';
import {
  createValidationSchema,
  validationIdParamSchema,
} from '../../domain/schemas/validation.schema';
import type { ValidationController } from '../controllers/validation.controller';
import { validate } from '../middlewares/validate';

/** Rutas protegidas: el JWT se exige para todo el router. */
export function createValidationRouter(
  controller: ValidationController,
  authenticate: RequestHandler,
): Router {
  const router = Router();
  router.use(authenticate);
  router.post('/', validate({ body: createValidationSchema }), controller.create);
  router.get('/:id', validate({ params: validationIdParamSchema }), controller.getById);
  return router;
}
