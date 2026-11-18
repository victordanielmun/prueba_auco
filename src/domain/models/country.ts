/**
 * Origen del dato dentro del servicio:
 *  - api         : respuesta fresca de APICountries
 *  - cache       : caché en memoria vigente
 *  - stale-cache : caché vencida, usada porque APICountries falló
 *  - fallback    : sin dato disponible; enriquecimiento degradado
 */
export type EnrichmentOrigin = 'api' | 'cache' | 'stale-cache' | 'fallback';

/** Datos del país con los que se enriquece una validación. */
export interface CountryEnrichment {
  /** Proveedor externo del enriquecimiento. */
  provider: 'apicountries';
  /** ISO 3166-1 alpha-2, en mayúsculas. */
  code: string;
  name: string;
  region: string | null;
  subregion: string | null;
  capital: string | null;
  currencies: string[];
  callingCode: string | null;
  origin: EnrichmentOrigin;
  /** ISO 8601 del momento en que se obtuvo el dato del proveedor. */
  enrichedAt: string;
}
