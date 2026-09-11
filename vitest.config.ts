import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The SDK's fake plugin host bundle pulls in CommonJS and native
    // dependencies (better-sqlite3); let Node resolve it instead of Vite.
    server: { deps: { external: ["@get-bb/plugin-sdk/testing"] } },
  },
});
