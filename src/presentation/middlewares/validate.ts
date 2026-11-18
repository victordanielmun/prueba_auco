import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';
import { InputValidationError, type ErrorDetail } from '../../domain/errors';

interface Schemas {
  body?: ZodTypeAny;
  params?: ZodTypeAny;
}

/** Valida body/params con Zod y reemplaza el valor por el resultado normalizado. */
export function validate(schemas: Schemas): RequestHandler {
  return (req, _res, next) => {
    const details: ErrorDetail[] = [];

    for (const target of ['body', 'params'] as const) {
      const schema = schemas[target];
      if (!schema) continue;
      const result = schema.safeParse(req[target]);
      if (result.success) {
        (req as unknown as Record<string, unknown>)[target] = result.data;
      } else {
        for (const issue of result.error.issues) {
          details.push({
            field: [target, ...issue.path].join('.'),
            message: issue.message,
          });
        }
      }
    }

    if (details.length > 0) return next(new InputValidationError(details));
    return next();
  };
}
