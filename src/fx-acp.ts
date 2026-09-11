import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/**
 * fx returns both `provider` and `model` with category `model`, provider first.
 * The shared bridge selects the first model-category option. Preserve every
 * option and value, but put the actual model first in responses and updates.
 */
export function normalizeFxConfigOptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeFxConfigOptions);
  if (value === null || typeof value !== "object") return value;
  const result: Record<string, unknown> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (key === "configOptions" && Array.isArray(item)) {
      const model = item.findIndex((option) => option?.id === "model");
      result[key] =
        model > 0
          ? [item[model], ...item.slice(0, model), ...item.slice(model + 1)]
          : item;
    } else {
      result[key] = normalizeFxConfigOptions(item);
    }
  }
  return result;
}

/** fx uses `refused` where ACP specifies the stop reason `refusal`. */
export function normalizeFxMessage(value: unknown): unknown {
  const message = normalizeFxConfigOptions(value);
  if (
    message !== null &&
    typeof message === "object" &&
    !Array.isArray(message)
  ) {
    const result = (message as Record<string, unknown>).result;
    if (
      result !== null &&
      typeof result === "object" &&
      !Array.isArray(result)
    ) {
      const fields = result as Record<string, unknown>;
      if (fields.stopReason === "refused") fields.stopReason = "refusal";
    }
  }
  return message;
}

/** Runs only when the host artifact is executed explicitly in adapter mode. */
export function runFxAcp(command: string, args: string[]): void {
  const child = spawn(command, args, { stdio: ["pipe", "pipe", "inherit"] });
  process.stdin.pipe(child.stdin);
  // A disappearing ACP process must not turn a late stdin write into an
  // unhandled EPIPE. The child's exit/error determines our exit status.
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    let output = line;
    try {
      output = JSON.stringify(normalizeFxMessage(JSON.parse(line)));
    } catch {
      // Preserve malformed output so the shared bridge reports the error.
    }
    if (!process.stdout.write(`${output}\n`)) child.stdout.pause();
  });
  process.stdout.on("drain", () => child.stdout.resume());
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => child.kill(signal));
  }
  child.on("error", (error) => {
    console.error(`Cannot start fx ACP: ${error.message}`);
    process.exitCode = 1;
    process.stdin.destroy();
  });
  child.on("close", (code, signal) => {
    lines.close();
    process.exitCode = code ?? (signal ? 1 : 0);
    process.stdin.destroy();
  });
}
