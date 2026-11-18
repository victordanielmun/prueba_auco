import type { ValidationAuditEvent } from '../domain/models';
import type { AuditRepository } from '../domain/ports';
import { errorMeta, type Logger } from '../shared/logger';

/**
 * La auditoría es best-effort: si DynamoDB falla se registra el error,
 * pero la operación de negocio (ya persistida en Mongo) no se revierte ni se rechaza.
 */
export async function recordAuditSafely(
  audit: AuditRepository,
  event: ValidationAuditEvent,
  logger: Logger,
): Promise<void> {
  try {
    await audit.record(event);
  } catch (err) {
    logger.error('audit event could not be recorded', {
      eventType: event.eventType,
      validationId: event.validationId,
      ...errorMeta(err),
    });
  }
}
