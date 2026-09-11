import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Remove only the shared bridge's synthetic ACP fallback, including on
 * models left unprobed when its discovery deadline expires. A genuine
 * medium-only control has its own fx description and must be preserved.
 */
export function normalizeFxModelCatalog(result: unknown): unknown {
  if (result === null || typeof result !== "object") return result;
  const catalog = result as Record<string, unknown>;
  const normalize = (models: unknown) =>
    Array.isArray(models)
      ? models.map((model) => {
          const efforts = model?.supportedReasoningEfforts;
          return Array.isArray(efforts) &&
            efforts.length === 1 &&
            efforts[0]?.reasoningEffort === "medium" &&
            efforts[0]?.description ===
              "Reasoning effort is managed by the connected ACP agent."
            ? { ...model, supportedReasoningEfforts: [] }
            : model;
        })
      : models;
  return {
    ...catalog,
    ...(Array.isArray(catalog.models)
      ? { models: normalize(catalog.models) }
      : {}),
    ...(Array.isArray(catalog.selectedOnlyModels)
      ? { selectedOnlyModels: normalize(catalog.selectedOnlyModels) }
      : {}),
  };
}

/** Model probes are isolated subprocesses; normal thread traffic uses the
 * shared bridge directly. Importing the host artifact starts no processes.
 */
export function createFxModelCatalogProxy(modulePath: string, flag: string) {
  const send = (message: unknown) =>
    process.stdout.write(`${JSON.stringify(message)}\n`);
  const cleanups = new Set<() => void>();
  return {
    request(line: string, id: string | number): void {
      const child = spawn(process.execPath, [modulePath, flag], {
        stdio: ["pipe", "pipe", "inherit"],
        // Keep the probe and its ACP descendants in a group for cancellation.
        detached: process.platform !== "win32",
      });
      const lines = createInterface({ input: child.stdout });
      let settled = false;
      const cleanup = () => {
        settled = true;
        clearTimeout(timer);
        cleanups.delete(cleanup);
        lines.close();
        child.stdin.destroy();
        try {
          if (process.platform !== "win32" && child.pid) {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          // The probe may already have exited.
        }
      };
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        send({ jsonrpc: "2.0", id, error: { code: -32000, message } });
        cleanup();
      };
      const timer = setTimeout(
        () => fail("fx model discovery timed out"),
        40_000,
      );
      cleanups.add(cleanup);
      child.on("error", (error) =>
        fail(`Cannot start fx model discovery: ${error.message}`),
      );
      child.on("close", () =>
        fail("fx model discovery exited before responding"),
      );
      child.stdin.on("error", (error) =>
        fail(`Cannot request fx models: ${error.message}`),
      );
      lines.on("line", (output) => {
        let response;
        try {
          response = JSON.parse(output);
        } catch {
          fail("fx model discovery returned invalid JSON");
          return;
        }
        if (settled || response?.id !== id || response.method) return;
        settled = true;
        send(
          "result" in response
            ? { ...response, result: normalizeFxModelCatalog(response.result) }
            : response,
        );
        cleanup();
      });
      child.stdin.write(`${line}\n`);
    },
    close(): void {
      for (const cleanup of cleanups) cleanup();
    },
  };
}
