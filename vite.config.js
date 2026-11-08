import { defineConfig } from "vite";

const headers = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

export default defineConfig({
  base: "./",
  server: { host: "127.0.0.1", port: 8088, strictPort: true, headers },
  preview: { host: "127.0.0.1", port: 8088, strictPort: true, headers },
  worker: { format: "es" },
});
