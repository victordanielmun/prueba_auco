# Validation Service

Microservicio de validación en **Node.js + TypeScript + Express**. Valida un documento, lo enriquece con **APICountries**, guarda el resultado en **MongoDB** y registra un evento de auditoría en **DynamoDB Local** (clave por documento y fecha). Incluye JWT, Zod, Swagger, `/health`, seguridad básica y un middleware centralizado de errores. Sin Redis.

## Requisitos

- Docker y Docker Compose
- Node.js 20+ (solo para desarrollo local y pruebas)

## Puesta en marcha

```bash
cp .env.example .env          # en PowerShell: Copy-Item .env.example .env
docker compose up --build -d  # MongoDB + DynamoDB Local + API, todos con healthcheck
docker compose ps             # los tres deben aparecer "healthy"
```

| Recurso | URL |
|---|---|
| API | http://localhost:3000 |
| Swagger UI | http://localhost:3000/docs |
| OpenAPI JSON | http://localhost:3000/docs.json |
| Health (readiness) | http://localhost:3000/health |
| Liveness | http://localhost:3000/health/live |

Para detener: `docker compose down` (añade `-v` para borrar los datos de Mongo).

## Uso rápido

Todas las rutas de `/validations` exigen `Authorization: Bearer <JWT>` (HS256, firmado con `JWT_SECRET`). Para generar un token de desarrollo:

```bash
npm install
npm run token                 # imprime un JWT válido por 1 h
```

```bash
TOKEN=$(npm run --silent token)

# Crear (201)
curl -s -X POST http://localhost:3000/validations \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Ada Lovelace","documentNumber":"ab 123456","countryCode":"co"}'

# Consultar (200 / 400 id inválido / 404 no existe)
curl -s http://localhost:3000/validations/<id> -H "Authorization: Bearer $TOKEN"
```

Respuesta de `POST /validations` (`201`, cabecera `Location: /validations/<id>`):

```json
{
  "id": "e241464f-a6c9-405f-9b99-aad2ff231bdb",
  "name": "Ada Lovelace",
  "documentNumber": "AB123456",
  "countryCode": "CO",
  "status": "APPROVED",
  "reasons": [],
  "enrichment": {
    "provider": "apicountries", "code": "CO", "name": "Colombia",
    "region": "Americas", "subregion": "South America", "capital": "Bogotá",
    "currencies": ["COP"], "callingCode": "+57",
    "origin": "api", "enrichedAt": "2026-11-18T19:00:55.574Z"
  },
  "createdAt": "2026-11-18T19:00:55.574Z"
}
```

### Reglas de negocio

| Estado | Cuándo |
|---|---|
| `APPROVED` | `documentNumber` válido (5-20 caracteres: A-Z, 0-9 o guion, tras normalizar) y, si se indicó `countryCode`, el país existe. Sin `countryCode` no se consulta APICountries. |
| `REJECTED` | Formato de documento inválido o país inexistente. Se responde `201` porque la validación se creó; el motivo va en `reasons`. |
| `REVIEW` | Se indicó país pero APICountries no respondió y no había caché (`enrichment.origin = "fallback"`). |

### Errores

Un único formato para todos los errores:

```json
{ "error": { "code": "VALIDATION_ERROR", "message": "...", "details": [{ "field": "body.name", "message": "..." }], "requestId": "..." } }
```

| HTTP | `code` | Causa |
|---|---|---|
| 400 | `VALIDATION_ERROR` / `INVALID_JSON` | Body o `id` inválido |
| 401 | `UNAUTHORIZED` | Token ausente, mal formado, expirado o con firma inválida |
| 404 | `NOT_FOUND` | Registro o ruta inexistente |
| 413 | `PAYLOAD_TOO_LARGE` | Body mayor que `BODY_LIMIT` |
| 429 | `RATE_LIMITED` | Se superó `RATE_LIMIT_MAX` por ventana |
| 503 | `REPOSITORY_ERROR` | Fallo de MongoDB/DynamoDB (mensaje genérico al cliente) |
| 500 | `INTERNAL_ERROR` | Error no previsto (mensaje genérico; el detalle solo va a los logs) |

Cada respuesta incluye `x-request-id` (se reutiliza el del cliente si es seguro).

## Arquitectura

```
src/
  domain/          modelos, errores, esquemas Zod, reglas y puertos (interfaces). Sin Express ni drivers.
  application/     casos de uso: CreateValidation, GetValidation.
  infrastructure/  adaptadores: APICountries (+caché TTL), MongoDB, DynamoDB Local.
  presentation/    controladores, rutas, middlewares y OpenAPI.
  config/          variables de entorno validadas con Zod.
  shared/          logger JSON.
  app.ts           createApp(deps): arma Express, no abre puertos ni conexiones.
  container.ts     composition root: conecta adaptadores, casos de uso y app.
  server.ts        listen + apagado ordenado (SIGTERM/SIGINT).
```

La dependencia siempre apunta hacia el dominio: `presentation → application → domain ← infrastructure`.

### Decisiones SOLID

- **S** — Cada pieza tiene una sola razón de cambio: los controladores solo traducen HTTP, los casos de uso orquestan, los adaptadores hablan con un sistema externo.
- **O** — Añadir una regla de validación o un middleware no obliga a modificar los controladores; la caché de países vive dentro del adaptador y se cambia sin tocar el caso de uso.
- **L** — Cualquier implementación de `ValidationRepository`, `AuditRepository` o `CountryClient` es intercambiable; los tests usan fakes en memoria con el mismo contrato.
- **I** — Puertos pequeños y específicos (`insert/findById`, `record`, `getByCode`, `check`) en lugar de una interfaz de persistencia grande.
- **D** — Los casos de uso reciben puertos por constructor; solo `container.ts` conoce las implementaciones concretas. Por eso `createApp()` y `listen()` están separados: los tests montan la app con fakes en un puerto efímero.

### Datos

- **MongoDB** `validations`: el `id` de dominio (UUID) se guarda como `_id`; índice `{ documentNumber, createdAt }`.
- **DynamoDB Local** `validation_audit_events`: PK `documentNumber`, SK `eventTimestamp` = fecha ISO + `#` + `eventId` (por ejemplo `2026-11-18T19:00:55.574Z#dc81177f-…`). El sufijo evita colisiones entre eventos del mismo milisegundo y mantiene el orden cronológico. Se registran `VALIDATION_CREATED` y `VALIDATION_QUERIED`. La tabla se crea al arrancar de forma idempotente (si ya existe, o si otra instancia la crea a la vez, no falla).

### APICountries: timeout, caché y fallback

`CountriesApiClient` consulta `GET {COUNTRIES_API_URL}/alpha/{code}` con:

1. **Timeout** por petición (`COUNTRIES_TIMEOUT_MS`).
2. **Caché en memoria con TTL** (`COUNTRIES_CACHE_TTL_MS`), también para países inexistentes, y deduplicación de peticiones concurrentes al mismo código.
3. **Fallback** si la API falla: primero la caché vencida (`origin: "stale-cache"`) y, si no hay nada, un enriquecimiento degradado (`origin: "fallback"`, estado `REVIEW`). Una caída de APICountries nunca tumba `POST /validations`.

### Seguridad

`helmet`, `x-powered-by` desactivado, body limitado a `BODY_LIMIT` (solo `application/json`), rate limit por IP (`RATE_LIMIT_MAX` por `RATE_LIMIT_WINDOW_MS`, `/health` exento), JWT con el algoritmo fijado a HS256, esquemas Zod `strict` y errores internos sin detalles hacia el cliente.

## Pruebas

```bash
npm install
npm test            # unitarias (Vitest): esquemas, casos de uso, cliente de países, repos Mongo/Dynamo, app + errores
npm run typecheck
```

Pruebas de API con Playwright (usan solo el fixture `request`, no necesitan navegadores). Requieren el stack levantado y `JWT_SECRET` en `.env`:

```bash
docker compose up --build -d
npm run test:api
```

Cubren `/health`, `POST /validations`, `GET /validations/:id` y los códigos 400, 401, 404 y 413. Cada ejecución usa documentos únicos, así que puede repetirse sin limpiar la base de datos. Para apuntar a otro host: `API_BASE_URL=http://host:3000 npm run test:api`.

### Smoke test (PowerShell)

```powershell
.\scripts\smoke-test.ps1
```

Genera su propio JWT, recorre los endpoints con salida coloreada y consulta **DynamoDB Local por documento** para confirmar los eventos de auditoría. Devuelve código 0 si todo pasa. Parámetros: `-BaseUrl`, `-DynamoEndpoint`, `-AuditTable`, `-JwtSecret`, `-SkipDynamo`.

### Postman

Importa `postman/validation-service.postman_collection.json`, ajusta la variable `jwtSecret` al `JWT_SECRET` de tu `.env` y ejecútala con el Collection Runner. El token se genera solo antes de cada petición.

## Configuración

Ver `.env.example`. Las variables se validan al arrancar y el servicio falla con un mensaje claro si falta alguna. En producción `JWT_SECRET` debe tener al menos 32 caracteres.

| Variable | Descripción |
|---|---|
| `PORT`, `LOG_LEVEL` | Puerto y nivel de logs |
| `JWT_SECRET`, `JWT_EXPIRES_IN` | Firma y vigencia (para `npm run token`) |
| `BODY_LIMIT`, `RATE_LIMIT_WINDOW_MS`, `RATE_LIMIT_MAX` | Límites de seguridad |
| `MONGO_URI`, `MONGO_DB`, `MONGO_COLLECTION` | MongoDB |
| `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `DYNAMO_ENDPOINT`, `DYNAMO_AUDIT_TABLE` | DynamoDB Local (credenciales ficticias) |
| `COUNTRIES_API_URL`, `COUNTRIES_TIMEOUT_MS`, `COUNTRIES_CACHE_TTL_MS` | APICountries |

`docker-compose.yml` sobrescribe `MONGO_URI` y `DYNAMO_ENDPOINT` con los nombres de servicio de la red de Compose. DynamoDB Local corre en memoria: los eventos de auditoría se pierden al reiniciar ese contenedor.

## Limitaciones conocidas

- **APICountries**: `apicountries.com` redirige a `countries.dev`; el cliente sigue la redirección. Si el proveedor cambia su esquema, solo hay que tocar el mapper de `countries-api-client.ts`.
- **Caché y rate limit en memoria**: son por proceso. Con varias réplicas cada una tendría su propia caché y su propio contador (la solución habitual sería Redis, descartado por requisito).
- **Auditoría best-effort**: si DynamoDB falla, el error se registra en logs pero la validación ya guardada en Mongo se devuelve igualmente.
- **Detrás de un proxy** habría que configurar `trust proxy` para que el rate limit use la IP real del cliente.
