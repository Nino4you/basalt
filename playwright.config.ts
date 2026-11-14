import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  // GitHub runners have four cores; two workers left half of them idle.
  workers: process.env.CI ? 4 : 2,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://127.0.0.1:1420",
    trace: "retain-on-failure",
    // Existing suites assert German labels and German demo-note contents.
    // i18n.spec.ts overrides this to test the English application default.
    storageState: {
      cookies: [],
      origins: [
        {
          origin: "http://127.0.0.1:1420",
          localStorage: [
            { name: "basalt-settings", value: '{"language":"de"}' },
          ],
        },
      ],
    },
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 960 },
      },
    },
    {
      name: "android-layout",
      use: { ...devices["Pixel 7"], defaultBrowserType: "chromium" },
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:1420",
    reuseExistingServer: !process.env.CI,
  },
});
