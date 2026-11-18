import 'dotenv/config';
import { defineConfig } from '@playwright/test';

/**
 * Pruebas de API contra el servicio ya levantado (docker compose up -d --build).
 * Solo usan el fixture `request`: no hace falta instalar navegadores.
 */
export default defineConfig({
  testDir: './tests/api',
  fullyParallel: true,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.API_BASE_URL ?? `http://localhost:${process.env.PORT ?? 3000}`,
    extraHTTPHeaders: { Accept: 'application/json' },
  },
});
