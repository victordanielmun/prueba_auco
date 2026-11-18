import type { CountryEnrichment } from './country';

/**
 * APPROVED  - número de documento válido y, si se indicó país, verificado.
 * REJECTED  - el documento no cumple el formato o el país no existe.
 * REVIEW    - se indicó país pero no pudo verificarse (APICountries no disponible).
 */
export const VALIDATION_STATUSES = ['APPROVED', 'REJECTED', 'REVIEW'] as const;
export type ValidationStatus = (typeof VALIDATION_STATUSES)[number];

/** Entrada ya validada (Zod) para crear una validación. */
export interface CreateValidationInput {
  name: string;
  documentNumber: string;
  /** ISO 3166-1 alpha-2, en mayúsculas. Opcional. */
  countryCode?: string;
}

/** Registro persistido en MongoDB. */
export interface ValidationRecord {
  id: string;
  name: string;
  documentNumber: string;
  countryCode: string | null;
  status: ValidationStatus;
  reasons: string[];
  /** `null` si no se indicó país o el país no existe. */
  enrichment: CountryEnrichment | null;
  createdAt: Date;
}
