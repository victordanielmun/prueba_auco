import type { ValidationStatus } from './validation';

export type AuditEventType = 'VALIDATION_CREATED' | 'VALIDATION_QUERIED';

/**
 * Evento de auditoría persistido en DynamoDB (`validation_audit_events`).
 * Clave primaria: `documentNumber` (partición) + `eventTimestamp` (orden).
 */
export interface ValidationAuditEvent {
  documentNumber: string;
  /** Fecha ISO-8601 UTC + sufijo único: `2026-11-18T13:12:00.000Z#<eventId>`. Sort key. */
  eventTimestamp: string;
  eventId: string;
  eventType: AuditEventType;
  validationId: string;
  status: ValidationStatus;
}

/** Sort key única y ordenable cronológicamente: dos eventos en el mismo ms no colisionan. */
export function buildEventTimestamp(date: Date, eventId: string): string {
  return `${date.toISOString()}#${eventId}`;
}
