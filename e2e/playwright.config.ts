import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  outputDir: './results/artifacts',
  globalSetup: './global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  reporter: [['list'], ['html', { outputFolder: './results/report', open: 'never' }]],
  use: {
    baseURL: 'https://photos.e2e.test',
    ignoreHTTPSErrors: true, // the stack uses a throwaway test CA
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
