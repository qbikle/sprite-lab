import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 30_000,
  use: {
    baseURL: 'http://localhost:5199',
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: 'vite --port 5199 --strictPort',
    port: 5199,
    reuseExistingServer: true,
  },
});
