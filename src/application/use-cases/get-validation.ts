import { randomUUID } from 'node:crypto';
import { NotFoundError } from '../../domain/errors';
import { buildEventTimestamp, type ValidationRecord } from '../../domain/models';
import type { AuditRepository, ValidationRepository } from '../../domain/ports';
import type { Logger } from '../../shared/logger';
import { recordAuditSafely } from '../audit-recorder';

export interface GetValidationDeps {
  validations: ValidationRepository;
  audit: AuditRepository;
  logger: Logger;
  now?: () => Date;
}

export class GetValidationUseCase {
  private readonly now: () => Date;

  constructor(private readonly deps: GetValidationDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async execute(id: string): Promise<ValidationRecord> {
    const record = await this.deps.validations.findById(id);
    if (!record) throw new NotFoundError('Validation', id);

    const eventId = randomUUID();
    await recordAuditSafely(
      this.deps.audit,
      {
        documentNumber: record.documentNumber,
        eventTimestamp: buildEventTimestamp(this.now(), eventId),
        eventId,
        eventType: 'VALIDATION_QUERIED',
        validationId: record.id,
        status: record.status,
      },
      this.deps.logger,
    );

    return record;
  }
}
