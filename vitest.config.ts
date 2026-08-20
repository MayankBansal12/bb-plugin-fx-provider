import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    setupFiles: ["./tests/setup.ts"],
    server: {
      deps: {
        external: ["@get-bb/plugin-sdk/provider-bridge"],
      },
    },
  },
});
