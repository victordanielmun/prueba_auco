import { randomUUID } from 'node:crypto';
import {
  buildEventTimestamp,
  type CountryEnrichment,
  type CreateValidationInput,
  type ValidationRecord,
  type ValidationStatus,
} from '../../domain/models';
import type { AuditRepository, CountryClient, ValidationRepository } from '../../domain/ports';
import { isDocumentNumberValid } from '../../domain/rules/document-rules';
import type { Logger } from '../../shared/logger';
import { recordAuditSafely } from '../audit-recorder';

export interface CreateValidationDeps {
  validations: ValidationRepository;
  audit: AuditRepository;
  countries: CountryClient;
  logger: Logger;
  now?: () => Date;
  generateId?: () => string;
}

export class CreateValidationUseCase {
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(private readonly deps: CreateValidationDeps) {
    this.now = deps.now ?? (() => new Date());
    this.generateId = deps.generateId ?? randomUUID;
  }

  async execute(input: CreateValidationInput): Promise<ValidationRecord> {
    const enrichment = input.countryCode
      ? await this.deps.countries.getByCode(input.countryCode)
      : null;

    const { status, reasons } = this.evaluate(input, enrichment);

    const record: ValidationRecord = {
      id: this.generateId(),
      name: input.name,
      documentNumber: input.documentNumber,
      countryCode: input.countryCode ?? null,
      status,
      reasons,
      enrichment,
      createdAt: this.now(),
    };

    await this.deps.validations.insert(record);

    const eventId = randomUUID();
    await recordAuditSafely(
      this.deps.audit,
      {
        documentNumber: record.documentNumber,
        eventTimestamp: buildEventTimestamp(record.createdAt, eventId),
        eventId,
        eventType: 'VALIDATION_CREATED',
        validationId: record.id,
        status: record.status,
      },
      this.deps.logger,
    );

    return record;
  }

  private evaluate(
    input: CreateValidationInput,
    enrichment: CountryEnrichment | null,
  ): { status: ValidationStatus; reasons: string[] } {
    const reasons: string[] = [];

    if (!isDocumentNumberValid(input.documentNumber)) {
      reasons.push('documentNumber must have 5-20 characters (A-Z, 0-9 or hyphen)');
    }
    if (input.countryCode && enrichment === null) {
      reasons.push(`countryCode '${input.countryCode}' is not a known country`);
    }
    if (reasons.length > 0) return { status: 'REJECTED', reasons };

    if (enrichment?.origin === 'fallback') {
      return {
        status: 'REVIEW',
        reasons: ['country could not be verified: APICountries unavailable'],
      };
    }
    return { status: 'APPROVED', reasons: [] };
  }
}
