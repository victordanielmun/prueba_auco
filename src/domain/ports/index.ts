import type {
  CountryEnrichment,
  ValidationAuditEvent,
  ValidationRecord,
} from '../models';

/** Puerto: persistencia de validaciones (MongoDB). */
export interface ValidationRepository {
  insert(record: ValidationRecord): Promise<void>;
  findById(id: string): Promise<ValidationRecord | null>;
}

/** Puerto: auditoría append-only (DynamoDB). */
export interface AuditRepository {
  record(event: ValidationAuditEvent): Promise<void>;
}

/** Puerto: enriquecimiento por país (APICountries). */
export interface CountryClient {
  /**
   * Devuelve el país, o `null` si el código no existe.
   * Ante fallos de red/timeout NO lanza: degrada a caché vencida o a `source: 'fallback'`.
   */
  getByCode(code: string): Promise<CountryEnrichment | null>;
}

/** Comprobación de salud de una dependencia. */
export interface HealthProbe {
  readonly name: string;
  check(): Promise<void>;
}
