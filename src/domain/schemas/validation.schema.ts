import { z } from 'zod';
import { normalizeDocumentNumber } from '../rules/document-rules';

/** Body de `POST /validations`. `.strict()` rechaza campos desconocidos. */
export const createValidationSchema = z
  .object({
    name: z
      .string({ required_error: 'name is required' })
      .trim()
      .min(2, 'name must have at least 2 characters')
      .max(120, 'name must be at most 120 characters'),
    documentNumber: z
      .string({ required_error: 'documentNumber is required' })
      .trim()
      .min(1, 'documentNumber must not be empty')
      .max(32, 'documentNumber must be at most 32 characters')
      .transform(normalizeDocumentNumber),
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'countryCode must be an ISO 3166-1 alpha-2 code')
      .transform((v) => v.toUpperCase())
      .optional(),
  })
  .strict();

/** Params de `GET /validations/:id`. */
export const validationIdParamSchema = z.object({
  id: z.string().uuid('id must be a valid UUID'),
});

export type CreateValidationBody = z.infer<typeof createValidationSchema>;
export type ValidationIdParams = z.infer<typeof validationIdParamSchema>;
