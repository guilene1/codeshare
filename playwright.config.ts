import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: process.env.DEVSHARE_BASE_URL ?? "http://localhost:3000",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: process.env.DEVSHARE_BASE_URL
    ? undefined
    : {
        command: "node backend/dist/index.js",
        url: "http://localhost:3000/api/health",
        reuseExistingServer: false,
        env: {
          DB_PATH: "data/e2e.sqlite",
          ALLOWED_ORIGINS: "http://localhost:3000",
          AUTH_SIGNUP_PER_HOUR: "500",
          AUTH_SIGNIN_PER_15MIN: "500",
        },
        timeout: 30_000,
      },
});
