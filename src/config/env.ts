import 'dotenv/config';
import { z } from 'zod';

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

    JWT_SECRET: z.string().min(16, 'JWT_SECRET must have at least 16 characters'),
    JWT_EXPIRES_IN: z.string().default('1h'),
    BODY_LIMIT: z.string().default('10kb'),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),

    MONGO_URI: z.string().min(1),
    MONGO_DB: z.string().min(1).default('validation_service'),
    MONGO_COLLECTION: z.string().min(1).default('validations'),

    AWS_REGION: z.string().default('us-east-1'),
    AWS_ACCESS_KEY_ID: z.string().default('local'),
    AWS_SECRET_ACCESS_KEY: z.string().default('local'),
    DYNAMO_ENDPOINT: z.string().url().optional(),
    DYNAMO_AUDIT_TABLE: z.string().min(1).default('validation_audit_events'),

    COUNTRIES_API_URL: z.string().url().default('https://apicountries.com'),
    COUNTRIES_TIMEOUT_MS: z.coerce.number().int().positive().default(3000),
    COUNTRIES_CACHE_TTL_MS: z.coerce.number().int().nonnegative().default(3_600_000),
  })
  .superRefine((env, ctx) => {
    if (env.NODE_ENV === 'production' && env.JWT_SECRET.length < 32) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_SECRET'],
        message: 'JWT_SECRET must have at least 32 characters in production',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

/** Valida y tipa las variables de entorno. Falla rápido con un mensaje legible. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || 'env'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${problems}`);
  }
  return parsed.data;
}
