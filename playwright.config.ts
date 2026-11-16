import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests against the built single file (run `npm run e2e`, which builds first), in two
 * projects:
 *  - "file": dist/index.html opened from disk, as with a downloaded copy;
 *  - "served": the same file served with the hosted page's headers (vercel.json, through
 *    scripts/serve.mjs), so anything the Content-Security-Policy would break fails here.
 * PRINTSHEET_URL points both at a deployed copy instead.
 */
const SERVED = 'http://localhost:4300/';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env['CI'] ? 2 : 4,
  retries: 0,
  reporter: process.env['CI'] ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'file' }, { name: 'served', use: { baseURL: SERVED }, grepInvert: /@stress/ }],
  webServer: {
    command: 'node scripts/serve.mjs 4300',
    url: SERVED,
    reuseExistingServer: !process.env['CI'],
  },
});
