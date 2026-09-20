import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests',
  use: {
    baseURL: 'http://127.0.0.1:1420',
    viewport: { width: 1480, height: 940 },
    channel: 'msedge',
  },
  webServer: {
    command: 'npm run dev:ui',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: true,
  },
  reporter: 'list',
});
