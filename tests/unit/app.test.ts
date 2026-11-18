import jwt from 'jsonwebtoken';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp, type AppDeps } from '../../src/app';
import type { CreateValidationUseCase } from '../../src/application/use-cases/create-validation';
import { CreateValidationUseCase as CreateUC } from '../../src/application/use-cases/create-validation';
import { GetValidationUseCase } from '../../src/application/use-cases/get-validation';
import { RepositoryError } from '../../src/domain/errors';
import {
  country,
  InMemoryAuditRepository,
  InMemoryValidationRepository,
  spyLogger,
  startApp,
  StubCountryClient,
} from './helpers/fakes';

const SECRET = 'unit-test-secret-with-more-than-32-chars!!';
const token = (opts: jwt.SignOptions = { expiresIn: '5m' }, secret = SECRET) =>
  jwt.sign({ sub: 'tester' }, secret, opts);
const auth = () => ({ Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' });
const VALID_BODY = { name: 'Ada Lovelace', documentNumber: 'ab123456', countryCode: 'co' };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const jsonOf = async (res: Response) => (await res.json()) as any;

let closeServer: (() => Promise<void>) | undefined;
afterEach(async () => {
  await closeServer?.();
  closeServer = undefined;
});

async function boot(overrides: Partial<AppDeps> = {}, rateLimitMax = 1000) {
  const validations = new InMemoryValidationRepository();
  const audit = new InMemoryAuditRepository();
  const logger = spyLogger();
  const app = createApp({
    createValidation: new CreateUC({ validations, audit, countries: new StubCountryClient(country()), logger }),
    getValidation: new GetValidationUseCase({ validations, audit, logger }),
    healthProbes: [{ name: 'mongodb', check: async () => undefined }],
    jwtSecret: SECRET,
    security: { bodyLimit: '1kb', rateLimitWindowMs: 60_000, rateLimitMax },
    logger,
    ...overrides,
  });
  const server = await startApp(app);
  closeServer = server.close;
  return { ...server, audit, logger, validations };
}

describe('autenticación JWT', () => {
  it.each([
    ['sin header', {}],
    ['esquema distinto de Bearer', { Authorization: 'Basic abc' }],
    ['token basura', { Authorization: 'Bearer not-a-jwt' }],
    ['firmado con otro secreto', { Authorization: `Bearer ${token({ expiresIn: '5m' }, 'x'.repeat(40))}` }],
    ['expirado', { Authorization: `Bearer ${token({ expiresIn: -10 })}` }],
    ['algoritmo none', { Authorization: `Bearer ${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from('{"sub":"x"}').toString('base64url')}.` }],
  ])('401: %s', async (_name, headers) => {
    const { baseUrl } = await boot();
    const res = await fetch(`${baseUrl}/validations`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(VALID_BODY) });
    expect(res.status).toBe(401);
    expect((await jsonOf(res)).error.code).toBe('UNAUTHORIZED');
  });

  it('/health y /docs.json no requieren token', async () => {
    const { baseUrl } = await boot();
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/docs.json`)).status).toBe(200);
  });
});

describe('POST /validations', () => {
  it('201 con id, Location y normalización', async () => {
    const { baseUrl, validations, audit } = await boot();
    const res = await fetch(`${baseUrl}/validations`, { method: 'POST', headers: auth(), body: JSON.stringify(VALID_BODY) });
    const body = await jsonOf(res);

    expect(res.status).toBe(201);
    expect(body).toMatchObject({ documentNumber: 'AB123456', countryCode: 'CO', status: 'APPROVED' });
    expect(res.headers.get('location')).toBe(`/validations/${body.id}`);
    expect(validations.items.has(body.id)).toBe(true);
    expect(audit.events).toHaveLength(1);
  });

  it('400 con detalle por campo cuando el body es inválido', async () => {
    const { baseUrl } = await boot();
    const res = await fetch(`${baseUrl}/validations`, { method: 'POST', headers: auth(), body: JSON.stringify({ name: 'A', extra: 1 }) });
    const { error } = await jsonOf(res);
    expect(res.status).toBe(400);
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details.map((d: { field: string }) => d.field)).toEqual(expect.arrayContaining(['body.name', 'body.documentNumber']));
  });

  it('400 INVALID_JSON con JSON malformado', async () => {
    const { baseUrl } = await boot();
    const res = await fetch(`${baseUrl}/validations`, { method: 'POST', headers: auth(), body: '{bad' });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error.code).toBe('INVALID_JSON');
  });

  it('413 si el body supera el límite', async () => {
    const { baseUrl } = await boot();
    const res = await fetch(`${baseUrl}/validations`, { method: 'POST', headers: auth(), body: JSON.stringify({ name: 'a'.repeat(5000) }) });
    expect(res.status).toBe(413);
    expect((await jsonOf(res)).error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});

describe('GET /validations/:id', () => {
  it('200 devuelve el registro creado', async () => {
    const { baseUrl } = await boot();
    const created = await jsonOf(await fetch(`${baseUrl}/validations`, { method: 'POST', headers: auth(), body: JSON.stringify(VALID_BODY) }));
    const res = await fetch(`${baseUrl}/validations/${created.id}`, { headers: auth() });
    expect(res.status).toBe(200);
    expect(await jsonOf(res)).toEqual(created);
  });

  it('400 si el id no es UUID', async () => {
    const { baseUrl } = await boot();
    const res = await fetch(`${baseUrl}/validations/abc`, { headers: auth() });
    expect(res.status).toBe(400);
    expect((await jsonOf(res)).error.details[0].field).toBe('params.id');
  });

  it('404 si no existe', async () => {
    const { baseUrl } = await boot();
    const res = await fetch(`${baseUrl}/validations/3f2b8c1e-6d7a-4c1b-9a53-0b6f1f9f2d10`, { headers: auth() });
    expect(res.status).toBe(404);
    expect((await jsonOf(res)).error.code).toBe('NOT_FOUND');
  });
});

describe('middleware centralizado de errores', () => {
  const failing = (err: unknown) =>
    ({ execute: async () => { throw err; } }) as unknown as CreateValidationUseCase;

  it('500 genérico: no filtra el mensaje interno', async () => {
    const { baseUrl, logger } = await boot({ createValidation: failing(new Error('password=hunter2 in stack')) });
    const res = await fetch(`${baseUrl}/validations`, { method: 'POST', headers: auth(), body: JSON.stringify(VALID_BODY) });
    const text = await res.text();
    expect(res.status).toBe(500);
    expect(text).not.toContain('hunter2');
    expect(JSON.parse(text).error.code).toBe('INTERNAL_ERROR');
    expect(logger.errors).toHaveLength(1);
  });

  it('503 genérico para fallos de repositorio', async () => {
    const { baseUrl } = await boot({ createValidation: failing(new RepositoryError('Mongo', new Error('conn string secret'))) });
    const res = await fetch(`${baseUrl}/validations`, { method: 'POST', headers: auth(), body: JSON.stringify(VALID_BODY) });
    const text = await res.text();
    expect(res.status).toBe(503);
    expect(text).not.toContain('secret');
  });

  it('404 con el mismo envelope para rutas desconocidas', async () => {
    const { baseUrl } = await boot();
    const res = await fetch(`${baseUrl}/nope`);
    expect(res.status).toBe(404);
    const { error } = await jsonOf(res);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.requestId).toBe(res.headers.get('x-request-id'));
  });

  it('reutiliza un x-request-id seguro y descarta uno malicioso', async () => {
    const { baseUrl } = await boot();
    const ok = await fetch(`${baseUrl}/health/live`, { headers: { 'x-request-id': 'trace-123' } });
    expect(ok.headers.get('x-request-id')).toBe('trace-123');
    const bad = await fetch(`${baseUrl}/health/live`, { headers: { 'x-request-id': 'a b<script>' } });
    expect(bad.headers.get('x-request-id')).not.toContain('<');
  });
});

describe('health y seguridad', () => {
  it('/health devuelve 503 si una dependencia está caída', async () => {
    const { baseUrl } = await boot({
      healthProbes: [
        { name: 'mongodb', check: async () => undefined },
        { name: 'dynamodb', check: async () => { throw new Error('down'); } },
      ],
    });
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(503);
    expect(await jsonOf(res)).toMatchObject({ status: 'degraded', checks: { mongodb: 'up', dynamodb: 'down' } });
  });

  it('helmet añade cabeceras y oculta x-powered-by', async () => {
    const { baseUrl } = await boot();
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-powered-by')).toBeNull();
  });

  it('429 cuando se supera el rate limit (y /health queda exento)', async () => {
    const { baseUrl } = await boot({}, 2);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i++) statuses.push((await fetch(`${baseUrl}/validations/abc`, { headers: auth() })).status);
    expect(statuses).toEqual([400, 400, 429]);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });
});
