import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import jwt from 'jsonwebtoken';

const SECRET = process.env.JWT_SECRET ?? '';
const bearer = (opts: jwt.SignOptions = { expiresIn: '5m' }, secret = SECRET) => ({
  Authorization: `Bearer ${jwt.sign({ sub: 'playwright' }, secret, opts)}`,
});

/** Documento único por ejecución: las corridas repetidas no chocan entre sí. */
const uniqueDocument = () => `PW${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

test.beforeAll(() => {
  if (!SECRET) throw new Error('JWT_SECRET is required (set it in .env or the environment)');
});

test.describe('health', () => {
  test('GET /health responde 200 con dependencias up', async ({ request }) => {
    const res = await request.get('/health');
    expect(res.status()).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', checks: { mongodb: 'up', dynamodb: 'up' } });
  });

  test('GET /docs.json expone OpenAPI', async ({ request }) => {
    const res = await request.get('/docs.json');
    expect(res.status()).toBe(200);
    expect((await res.json()).paths).toHaveProperty('/validations');
  });
});

test.describe('autenticación', () => {
  test('401 sin token', async ({ request }) => {
    const res = await request.post('/validations', { data: { name: 'Ada', documentNumber: uniqueDocument() } });
    expect(res.status()).toBe(401);
    expect((await res.json()).error.code).toBe('UNAUTHORIZED');
  });

  test('401 con token firmado con otro secreto', async ({ request }) => {
    const res = await request.get(`/validations/${randomUUID()}`, {
      headers: bearer({ expiresIn: '5m' }, 'another-secret-another-secret-123456'),
    });
    expect(res.status()).toBe(401);
  });

  test('401 con token expirado', async ({ request }) => {
    const res = await request.get(`/validations/${randomUUID()}`, { headers: bearer({ expiresIn: -60 }) });
    expect(res.status()).toBe(401);
  });
});

test.describe('POST /validations', () => {
  test('201 crea y devuelve el id; GET lo recupera con 200', async ({ request }) => {
    const documentNumber = uniqueDocument();

    const created = await request.post('/validations', {
      headers: bearer(),
      data: { name: 'Ada Lovelace', documentNumber, countryCode: 'co' },
    });
    expect(created.status()).toBe(201);
    const body = await created.json();
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body).toMatchObject({ documentNumber, countryCode: 'CO' });
    expect(['APPROVED', 'REVIEW']).toContain(body.status); // REVIEW si APICountries está caída
    expect(body.enrichment.provider).toBe('apicountries');
    expect(created.headers()['location']).toBe(`/validations/${body.id}`);

    const fetched = await request.get(`/validations/${body.id}`, { headers: bearer() });
    expect(fetched.status()).toBe(200);
    expect(await fetched.json()).toEqual(body);
  });

  test('201 REJECTED cuando el país no existe', async ({ request }) => {
    const res = await request.post('/validations', {
      headers: bearer(),
      data: { name: 'Bob', documentNumber: uniqueDocument(), countryCode: 'ZZ' },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    // Si APICountries estuviera caída, el estado sería REVIEW; con la API arriba es REJECTED.
    expect(['REJECTED', 'REVIEW']).toContain(body.status);
  });

  test('201 sin countryCode no consulta país', async ({ request }) => {
    const res = await request.post('/validations', {
      headers: bearer(),
      data: { name: 'Carl', documentNumber: uniqueDocument() },
    });
    expect(res.status()).toBe(201);
    expect(await res.json()).toMatchObject({ status: 'APPROVED', countryCode: null, enrichment: null });
  });

  test('repetir la misma petición crea registros distintos sin conflicto', async ({ request }) => {
    const data = { name: 'Dana', documentNumber: uniqueDocument() };
    const [a, b] = await Promise.all([
      request.post('/validations', { headers: bearer(), data }),
      request.post('/validations', { headers: bearer(), data }),
    ]);
    expect([a.status(), b.status()]).toEqual([201, 201]);
    expect((await a.json()).id).not.toBe((await b.json()).id);
  });

  test('400 con detalle por campo si el body es inválido', async ({ request }) => {
    const res = await request.post('/validations', { headers: bearer(), data: { name: 'A', unknown: true } });
    expect(res.status()).toBe(400);
    const { error } = await res.json();
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.details.length).toBeGreaterThan(0);
  });

  test('400 si el JSON está malformado', async ({ request }) => {
    const res = await request.post('/validations', {
      headers: { ...bearer(), 'Content-Type': 'application/json' },
      data: '{bad json',
    });
    expect(res.status()).toBe(400);
  });

  test('413 si el body supera el límite', async ({ request }) => {
    const res = await request.post('/validations', {
      headers: bearer(),
      data: { name: 'a'.repeat(20_000), documentNumber: uniqueDocument() },
    });
    expect(res.status()).toBe(413);
  });
});

test.describe('GET /validations/:id', () => {
  test('400 si el id no es un UUID', async ({ request }) => {
    const res = await request.get('/validations/not-a-uuid', { headers: bearer() });
    expect(res.status()).toBe(400);
    expect((await res.json()).error.details[0].field).toBe('params.id');
  });

  test('404 si no existe', async ({ request }) => {
    const res = await request.get(`/validations/${randomUUID()}`, { headers: bearer() });
    expect(res.status()).toBe(404);
    expect((await res.json()).error.code).toBe('NOT_FOUND');
  });
});
