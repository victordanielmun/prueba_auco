import type { Express } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type {
  CountryEnrichment,
  ValidationAuditEvent,
  ValidationRecord,
} from '../../../src/domain/models';
import type { AuditRepository, CountryClient, ValidationRepository } from '../../../src/domain/ports';
import type { Logger } from '../../../src/shared/logger';

export class InMemoryValidationRepository implements ValidationRepository {
  readonly items = new Map<string, ValidationRecord>();
  async insert(record: ValidationRecord) {
    this.items.set(record.id, record);
  }
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
}

export class InMemoryAuditRepository implements AuditRepository {
  readonly events: ValidationAuditEvent[] = [];
  failWith: Error | null = null;
  async record(event: ValidationAuditEvent) {
    if (this.failWith) throw this.failWith;
    this.events.push(event);
  }
}

/** `result`: país a devolver; `null` simula país inexistente. */
export class StubCountryClient implements CountryClient {
  calls: string[] = [];
  constructor(public result: CountryEnrichment | null) {}
  async getByCode(code: string) {
    this.calls.push(code);
    return this.result;
  }
}

export function country(overrides: Partial<CountryEnrichment> = {}): CountryEnrichment {
  return {
    provider: 'apicountries',
    code: 'CO',
    name: 'Colombia',
    region: 'Americas',
    subregion: 'South America',
    capital: 'Bogotá',
    currencies: ['COP'],
    callingCode: '+57',
    origin: 'api',
    enrichedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export function spyLogger(): Logger & { errors: Array<{ msg: string; meta?: Record<string, unknown> }> } {
  const errors: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
  return {
    errors,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: (msg, meta) => {
      errors.push({ msg, meta });
    },
  };
}

/** Levanta una app Express en un puerto efímero para probarla con fetch. */
export async function startApp(app: Express) {
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
