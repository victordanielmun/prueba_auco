import { Router } from 'express';
import type { HealthProbe } from '../../domain/ports';
import { asyncHandler } from '../middlewares/async-handler';

const PROBE_TIMEOUT_MS = 2000;

async function runProbe(probe: HealthProbe): Promise<'up' | 'down'> {
  try {
    await Promise.race([
      probe.check(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), PROBE_TIMEOUT_MS).unref()),
    ]);
    return 'up';
  } catch {
    return 'down';
  }
}

export function createHealthRouter(probes: HealthProbe[]): Router {
  const router = Router();

  /** Liveness: el proceso responde (usado por el healthcheck de Docker). */
  router.get('/health/live', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  /** Readiness: comprueba las dependencias; 503 si alguna está caída. */
  router.get(
    '/health',
    asyncHandler(async (_req, res) => {
      const results = await Promise.all(probes.map(async (p) => [p.name, await runProbe(p)] as const));
      const checks = Object.fromEntries(results);
      const healthy = results.every(([, state]) => state === 'up');
      res.status(healthy ? 200 : 503).json({
        status: healthy ? 'ok' : 'degraded',
        uptimeSeconds: Math.round(process.uptime()),
        checks,
      });
    }),
  );

  return router;
}
