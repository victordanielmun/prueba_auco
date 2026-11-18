export type DomainErrorCode =
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'NOT_FOUND'
  | 'EXTERNAL_SERVICE_ERROR'
  | 'REPOSITORY_ERROR'
  | 'INTERNAL_ERROR';

export interface ErrorDetail {
  field: string;
  message: string;
}

/** Base de los errores esperados. El middleware de errores los traduce a HTTP. */
export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    public readonly details?: ErrorDetail[],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InputValidationError extends DomainError {
  constructor(details: ErrorDetail[], message = 'Request validation failed') {
    super('VALIDATION_ERROR', message, details);
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Authentication required') {
    super('UNAUTHORIZED', message);
  }
}

export class NotFoundError extends DomainError {
  constructor(resource: string, id: string) {
    super('NOT_FOUND', `${resource} '${id}' not found`);
  }
}

export class ExternalServiceError extends DomainError {
  constructor(service: string, message = 'Upstream service unavailable') {
    super('EXTERNAL_SERVICE_ERROR', `${service}: ${message}`);
  }
}

export class RepositoryError extends DomainError {
  constructor(
    repository: string,
    public override readonly cause?: unknown,
  ) {
    super('REPOSITORY_ERROR', `${repository} operation failed`);
  }
}
