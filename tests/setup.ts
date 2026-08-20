import { createRequire } from "node:module";

// The published SDK's provider-bridge bundle contains CommonJS dependencies.
// BB's builder injects createRequire into host artifacts; mirror that in tests.
Object.defineProperty(globalThis, "require", {
  configurable: true,
  value: createRequire(import.meta.url),
});
