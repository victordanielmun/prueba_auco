import { describe, expect, it, vi } from 'vitest';
import { CountriesApiClient } from '../../src/infrastructure/countries/countries-api-client';

const COLOMBIA = {
  alpha2Code: 'CO',
  name: 'Colombia',
  region: 'Americas',
  subregion: 'South America',
  capital: 'Bogotá',
  currencies: [{ code: 'COP', name: 'Colombian peso' }],
  callingCodes: ['57'],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(fetchFn: ReturnType<typeof vi.fn>, opts: { ttl?: number; timeoutMs?: number } = {}) {
  const clock = { t: 1_000_000 };
  const client = new CountriesApiClient({
    baseUrl: 'https://api.test/',
    timeoutMs: opts.timeoutMs ?? 1000,
    cacheTtlMs: opts.ttl ?? 60_000,
    fetchFn: fetchFn as unknown as typeof fetch,
    now: () => clock.t,
  });
  return { client, clock };
}

describe('CountriesApiClient', () => {
  it('mapea la respuesta de APICountries a CountryEnrichment', async () => {
    const fetchFn = vi.fn().mockResolvedValue(json(COLOMBIA));
    const { client } = setup(fetchFn);

    const result = await client.getByCode('co');

    expect(fetchFn.mock.calls[0]![0]).toBe('https://api.test/alpha/CO');
    expect(result).toMatchObject({
      provider: 'apicountries',
      code: 'CO',
      name: 'Colombia',
      region: 'Americas',
      subregion: 'South America',
      capital: 'Bogotá',
      currencies: ['COP'],
      callingCode: '+57',
      origin: 'api',
    });
    expect(new Date(result!.enrichedAt).toISOString()).toBe(result!.enrichedAt);
  });

  it('sirve desde caché dentro del TTL', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => json(COLOMBIA));
    const { client, clock } = setup(fetchFn);

    await client.getByCode('CO');
    clock.t += 59_000;
    const second = await client.getByCode('CO');

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(second?.origin).toBe('cache');
  });

  it('vuelve a consultar cuando el TTL vence', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => json(COLOMBIA));
    const { client, clock } = setup(fetchFn);

    await client.getByCode('CO');
    clock.t += 60_001;
    const again = await client.getByCode('CO');

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(again?.origin).toBe('api');
  });

  it('usa la caché vencida (stale-cache) si la API falla', async () => {
    const fetchFn = vi
      .fn()
      .mockImplementationOnce(async () => json(COLOMBIA))
      .mockRejectedValue(new Error('network down'));
    const { client, clock } = setup(fetchFn);

    await client.getByCode('CO');
    clock.t += 120_000;
    const result = await client.getByCode('CO');

    expect(result).toMatchObject({ name: 'Colombia', origin: 'stale-cache' });
  });

  it('degrada a fallback si la API falla y no hay caché', async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error('network down'));
    const { client } = setup(fetchFn);

    const result = await client.getByCode('CO');

    expect(result).toMatchObject({ provider: 'apicountries', code: 'CO', origin: 'fallback', currencies: [] });
  });

  it('degrada a fallback ante un 5xx', async () => {
    const fetchFn = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }));
    const { client } = setup(fetchFn);
    expect((await client.getByCode('CO'))?.origin).toBe('fallback');
  });

  it('aplica timeout y degrada a fallback', async () => {
    const fetchFn = vi.fn().mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
        }),
    );
    const { client } = setup(fetchFn, { timeoutMs: 20 });

    const started = Date.now();
    const result = await client.getByCode('CO');

    expect(result?.origin).toBe('fallback');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('devuelve null (y lo cachea) cuando el país no existe', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => new Response('Country not found', { status: 404 }));
    const { client } = setup(fetchFn);

    expect(await client.getByCode('ZZ')).toBeNull();
    expect(await client.getByCode('ZZ')).toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('deduplica peticiones concurrentes al mismo código', async () => {
    const fetchFn = vi.fn().mockImplementation(async () => json(COLOMBIA));
    const { client } = setup(fetchFn);

    await Promise.all([client.getByCode('CO'), client.getByCode('co'), client.getByCode('CO')]);

    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
