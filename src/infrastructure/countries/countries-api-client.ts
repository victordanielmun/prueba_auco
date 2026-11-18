import type { CountryEnrichment } from '../../domain/models';
import type { CountryClient } from '../../domain/ports';
import { errorMeta, silentLogger, type Logger } from '../../shared/logger';

export interface CountriesApiClientOptions {
  baseUrl: string;
  timeoutMs: number;
  cacheTtlMs: number;
  fetchFn?: typeof fetch;
  /** Reloj inyectable (tests). */
  now?: () => number;
  logger?: Logger;
}

interface CacheEntry {
  /** `null` = el país no existe (caché negativa). */
  value: CountryEnrichment | null;
  expiresAt: number;
}

/** Forma de la respuesta de APICountries (`GET /alpha/{code}`). */
interface ApiCountry {
  alpha2Code?: string;
  name?: string;
  region?: string;
  subregion?: string;
  capital?: string;
  currencies?: Array<{ code?: string }>;
  callingCodes?: string[];
}

/**
 * Cliente de APICountries (https://apicountries.com, que redirige a countries.dev) con:
 *  - timeout por petición (AbortSignal),
 *  - caché en memoria con TTL (incluye caché negativa),
 *  - deduplicación de peticiones concurrentes al mismo código,
 *  - fallback: caché vencida -> enriquecimiento degradado (`origin: "fallback"`).
 */
export class CountriesApiClient implements CountryClient {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<CountryEnrichment | null>>();
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(private readonly options: CountriesApiClientOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? silentLogger;
  }

  async getByCode(code: string): Promise<CountryEnrichment | null> {
    const key = code.toUpperCase();
    const cached = this.cache.get(key);

    if (cached && cached.expiresAt > this.now()) {
      return cached.value ? { ...cached.value, origin: 'cache' } : null;
    }

    let pending = this.inFlight.get(key);
    if (!pending) {
      pending = this.fetchAndStore(key).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, pending);
    }

    try {
      return await pending;
    } catch (err) {
      this.logger.warn('countries api unavailable, using fallback', { code: key, ...errorMeta(err) });
      if (cached) return cached.value ? { ...cached.value, origin: 'stale-cache' } : null;
      return fallbackCountry(key, new Date(this.now()).toISOString());
    }
  }

  private async fetchAndStore(code: string): Promise<CountryEnrichment | null> {
    const value = await this.fetchCountry(code);
    this.cache.set(code, { value, expiresAt: this.now() + this.options.cacheTtlMs });
    return value;
  }

  private async fetchCountry(code: string): Promise<CountryEnrichment | null> {
    const url = `${this.options.baseUrl.replace(/\/+$/, '')}/alpha/${encodeURIComponent(code)}`;
    const res = await this.fetchFn(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });

    if (res.status === 404 || res.status === 400) return null; // país inexistente
    if (!res.ok) throw new Error(`APICountries responded ${res.status}`);

    const raw = (await res.json()) as ApiCountry;
    if (!raw?.name) return null;
    return toEnrichment(code, raw, new Date(this.now()).toISOString());
  }
}

function toEnrichment(code: string, raw: ApiCountry, enrichedAt: string): CountryEnrichment {
  const calling = raw.callingCodes?.[0];
  return {
    provider: 'apicountries',
    code: (raw.alpha2Code ?? code).toUpperCase(),
    name: raw.name ?? code,
    region: raw.region || null,
    subregion: raw.subregion || null,
    capital: raw.capital || null,
    currencies: (raw.currencies ?? []).map((c) => c.code).filter((c): c is string => !!c),
    callingCode: calling ? `+${calling}` : null,
    origin: 'api',
    enrichedAt,
  };
}

function fallbackCountry(code: string, enrichedAt: string): CountryEnrichment {
  return {
    code,
    name: code,
    region: null,
    subregion: null,
    capital: null,
    currencies: [],
    callingCode: null,
    provider: 'apicountries',
    origin: 'fallback',
    enrichedAt,
  };
}
