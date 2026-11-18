import { buildApplication } from './container';
import { loadEnv } from './config/env';
import { createLogger, errorMeta } from './shared/logger';

async function main(): Promise<void> {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);

  const { app, close } = await buildApplication(env, logger);
  const server = app.listen(env.PORT, () => {
    logger.info('validation-service listening', { port: env.PORT, env: env.NODE_ENV });
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { signal });
    // Si algo se cuelga, forzamos la salida tras 10 s.
    setTimeout(() => process.exit(1), 10_000).unref();
    server.close(() => {
      close()
        .catch((err) => logger.error('error while closing resources', errorMeta(err)))
        .finally(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  // El logger puede no existir si falló la configuración.
  console.error('fatal: could not start service', err instanceof Error ? err.message : err);
  process.exit(1);
});
