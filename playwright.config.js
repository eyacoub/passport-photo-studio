import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: "./tests",
  timeout: 420_000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8088", acceptDownloads: true,
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-video-capture=${fileURLToPath(new URL("./tests/fixtures/camera.y4m", import.meta.url))}`] },
  },
  webServer: { command: "npm start", url: "http://127.0.0.1:8088", reuseExistingServer: true },
});
