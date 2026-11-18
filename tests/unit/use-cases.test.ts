import { describe, expect, it } from 'vitest';
import { CreateValidationUseCase } from '../../src/application/use-cases/create-validation';
import { GetValidationUseCase } from '../../src/application/use-cases/get-validation';
import { NotFoundError } from '../../src/domain/errors';
import {
  country,
  InMemoryAuditRepository,
  InMemoryValidationRepository,
  spyLogger,
  StubCountryClient,
} from './helpers/fakes';

const FIXED = new Date('2026-05-01T10:00:00.000Z');

function build(countryResult = country() as ReturnType<typeof country> | null) {
  const validations = new InMemoryValidationRepository();
  const audit = new InMemoryAuditRepository();
  const countries = new StubCountryClient(countryResult);
  const logger = spyLogger();
  const create = new CreateValidationUseCase({
    validations,
    audit,
    countries,
    logger,
    now: () => FIXED,
    generateId: () => 'id-1',
  });
  const get = new GetValidationUseCase({ validations, audit, logger, now: () => FIXED });
  return { validations, audit, countries, logger, create, get };
}

describe('CreateValidationUseCase', () => {
  it('aprueba, enriquece, persiste y audita', async () => {
    const { create, validations, audit, countries } = build();

    const record = await create.execute({ name: 'Ada', documentNumber: 'AB123456', countryCode: 'CO' });

    expect(countries.calls).toEqual(['CO']);
    expect(record).toMatchObject({ id: 'id-1', status: 'APPROVED', reasons: [], countryCode: 'CO' });
    expect(record.enrichment?.provider).toBe('apicountries');
    expect(validations.items.get('id-1')).toEqual(record);

    expect(audit.events).toHaveLength(1);
    const event = audit.events[0]!;
    expect(event).toMatchObject({
      documentNumber: 'AB123456',
      eventType: 'VALIDATION_CREATED',
      validationId: 'id-1',
      status: 'APPROVED',
    });
    expect(event.eventTimestamp).toBe(`${FIXED.toISOString()}#${event.eventId}`);
  });

  it('aprueba sin consultar APICountries cuando no hay countryCode', async () => {
    const { create, countries } = build();
    const record = await create.execute({ name: 'Ada', documentNumber: 'AB123456' });
    expect(countries.calls).toEqual([]);
    expect(record).toMatchObject({ status: 'APPROVED', countryCode: null, enrichment: null });
  });

  it('rechaza si el país no existe', async () => {
    const { create } = build(null);
    const record = await create.execute({ name: 'Ada', documentNumber: 'AB123456', countryCode: 'ZZ' });
    expect(record.status).toBe('REJECTED');
    expect(record.reasons).toEqual(["countryCode 'ZZ' is not a known country"]);
    expect(record.enrichment).toBeNull();
  });

  it('rechaza si el documento no cumple el formato', async () => {
    const { create } = build();
    const record = await create.execute({ name: 'Ada', documentNumber: 'X1' });
    expect(record.status).toBe('REJECTED');
    expect(record.reasons[0]).toMatch(/documentNumber/);
  });

  it('marca REVIEW cuando el enriquecimiento cae en fallback', async () => {
    const { create } = build(country({ origin: 'fallback' }));
    const record = await create.execute({ name: 'Ada', documentNumber: 'AB123456', countryCode: 'CO' });
    expect(record.status).toBe('REVIEW');
    expect(record.reasons).toHaveLength(1);
  });

  it('un fallo de auditoría no rompe la operación y queda registrado', async () => {
    const { create, audit, validations, logger } = build();
    audit.failWith = new Error('dynamo down');

    const record = await create.execute({ name: 'Ada', documentNumber: 'AB123456' });

    expect(validations.items.has(record.id)).toBe(true);
    expect(logger.errors).toHaveLength(1);
    expect(logger.errors[0]!.msg).toMatch(/audit/);
  });

  it('propaga el error si falla la persistencia en Mongo', async () => {
    const { create, validations, audit } = build();
    validations.insert = async () => {
      throw new Error('mongo down');
    };
    await expect(create.execute({ name: 'Ada', documentNumber: 'AB123456' })).rejects.toThrow('mongo down');
    expect(audit.events).toHaveLength(0);
  });
});

describe('GetValidationUseCase', () => {
  it('devuelve el registro y audita la consulta', async () => {
    const { create, get, audit } = build();
    const created = await create.execute({ name: 'Ada', documentNumber: 'AB123456' });

    const found = await get.execute(created.id);

    expect(found).toEqual(created);
    expect(audit.events.map((e) => e.eventType)).toEqual(['VALIDATION_CREATED', 'VALIDATION_QUERIED']);
    const [first, second] = audit.events;
    expect(first!.eventTimestamp).not.toBe(second!.eventTimestamp); // sufijo único
  });

  it('lanza NotFoundError si no existe y no audita', async () => {
    const { get, audit } = build();
    await expect(get.execute('missing')).rejects.toBeInstanceOf(NotFoundError);
    expect(audit.events).toHaveLength(0);
  });
});
