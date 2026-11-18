import type { Express } from 'express';
import { createApp } from './app';
import { CreateValidationUseCase } from './application/use-cases/create-validation';
import { GetValidationUseCase } from './application/use-cases/get-validation';
import type { Env } from './config/env';
import { CountriesApiClient } from './infrastructure/countries/countries-api-client';
import {
  createDynamoClient,
  DynamoAuditRepository,
  ensureAuditTable,
} from './infrastructure/dynamo/dynamo-audit-repository';
import {
  createMongoClient,
  MongoValidationRepository,
} from './infrastructure/mongo/mongo-validation-repository';
import type { Logger } from './shared/logger';

export interface Application {
  app: Express;
  /** Cierra conexiones abiertas (graceful shutdown). */
  close(): Promise<void>;
}

/** Composition root: conecta infraestructura, casos de uso y Express. */
export async function buildApplication(env: Env, logger: Logger): Promise<Application> {
  const mongo = createMongoClient(env.MONGO_URI);
  await mongo.connect();
  const validations = new MongoValidationRepository(mongo, env.MONGO_DB, env.MONGO_COLLECTION);
  await validations.ensureIndexes();

  const dynamo = createDynamoClient({
    region: env.AWS_REGION,
    endpoint: env.DYNAMO_ENDPOINT,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
  });
  await ensureAuditTable(dynamo, env.DYNAMO_AUDIT_TABLE);
  const audit = new DynamoAuditRepository(dynamo, env.DYNAMO_AUDIT_TABLE);

  const countries = new CountriesApiClient({
    baseUrl: env.COUNTRIES_API_URL,
    timeoutMs: env.COUNTRIES_TIMEOUT_MS,
    cacheTtlMs: env.COUNTRIES_CACHE_TTL_MS,
    logger,
  });

  const app = createApp({
    createValidation: new CreateValidationUseCase({ validations, audit, countries, logger }),
    getValidation: new GetValidationUseCase({ validations, audit, logger }),
    healthProbes: [validations, audit],
    jwtSecret: env.JWT_SECRET,
    security: {
      bodyLimit: env.BODY_LIMIT,
      rateLimitWindowMs: env.RATE_LIMIT_WINDOW_MS,
      rateLimitMax: env.RATE_LIMIT_MAX,
    },
    logger,
  });

  return {
    app,
    close: async () => {
      await mongo.close();
      dynamo.destroy();
    },
  };
}
