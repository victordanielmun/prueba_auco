---
name: validation-service-architecture
description: Arquitectura y buenas prácticas del microservicio de validación (Node.js + TypeScript + Express + MongoDB + DynamoDB Local). Úsalo al crear o modificar código de este servicio.
---

# Microservicio de validación — arquitectura y buenas prácticas

## Capas (la dependencia siempre apunta hacia el dominio)

```
src/
  domain/          modelos, errores de dominio, esquemas Zod y puertos (interfaces). Sin dependencias de Express ni de drivers.
  application/     casos de uso. Dependen solo de puertos del dominio.
  infrastructure/  adaptadores: APICountries (caché TTL), MongoDB, DynamoDB Local.
  presentation/    Express: controladores, rutas, middlewares, Swagger.
  config/          variables de entorno validadas con Zod.
  shared/          logger y utilidades transversales.
  app.ts           createApp(deps) — construye Express sin abrir conexiones.
  container.ts     composition root: instancia adaptadores y casos de uso.
  server.ts        arranque y apagado ordenado (graceful shutdown).
```

## Reglas

1. Los casos de uso reciben sus dependencias por constructor (puertos), nunca importan drivers.
2. Todo input externo se valida con Zod en el borde (`validate` middleware) y el dominio lo tipa.
3. Errores de dominio (`DomainError` y subclases) llevan `code`; solo el middleware de errores los traduce a HTTP. Nunca se filtran stacks ni detalles internos al cliente.
4. Servicios externos (APICountries): timeout con `AbortController`, caché en memoria con TTL y fallback (valor en caché vencido o enriquecimiento degradado) — una caída externa no tumba el endpoint.
5. DynamoDB `validation_audit_events`: PK `documentNumber`, SK `eventTimestamp` (ISO + sufijo único); creación de tabla idempotente. La auditoría es *best effort*: un fallo se registra pero no rompe la respuesta.
6. Seguridad: `helmet`, límite de body, rate limit, JWT HS256 con algoritmo fijado, secretos solo por entorno.
7. Sin Redis: la caché es en memoria por proceso.
8. Pruebas: unitarias (Vitest, con fakes de puertos) y de API (`@playwright/test`) contra el servicio levantado con Docker Compose.
9. Commits pequeños por etapa, con mensajes en formato Conventional Commits.
