import type { RequestHandler } from 'express';
import type { CreateValidationUseCase } from '../../application/use-cases/create-validation';
import type { GetValidationUseCase } from '../../application/use-cases/get-validation';
import type { ValidationRecord } from '../../domain/models';
import type { CreateValidationBody, ValidationIdParams } from '../../domain/schemas/validation.schema';
import { asyncHandler } from '../middlewares/async-handler';

/** Representación HTTP del registro (fechas ISO, sin detalles de persistencia). */
export function toValidationResponse(record: ValidationRecord) {
  return {
    id: record.id,
    name: record.name,
    documentNumber: record.documentNumber,
    countryCode: record.countryCode,
    status: record.status,
    reasons: record.reasons,
    enrichment: record.enrichment,
    createdAt: record.createdAt.toISOString(),
  };
}

export interface ValidationController {
  create: RequestHandler;
  getById: RequestHandler;
}

/** Los controladores solo traducen HTTP <-> casos de uso. */
export function createValidationController(deps: {
  createValidation: CreateValidationUseCase;
  getValidation: GetValidationUseCase;
}): ValidationController {
  return {
    create: asyncHandler(async (req, res) => {
      const record = await deps.createValidation.execute(req.body as CreateValidationBody);
      res.status(201).location(`/validations/${record.id}`).json(toValidationResponse(record));
    }),

    getById: asyncHandler(async (req, res) => {
      const { id } = req.params as unknown as ValidationIdParams;
      const record = await deps.getValidation.execute(id);
      res.status(200).json(toValidationResponse(record));
    }),
  };
}
