import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type JsonRpcId = string | number;

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcRequest extends JsonRpcNotification {
  id: JsonRpcId;
}

export interface AcpConnection {
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  close(): Promise<void>;
}

export interface AcpConnectionOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  onNotification(notification: JsonRpcNotification): void;
  onExit(error: Error): void;
  onRequest?(request: JsonRpcRequest): Promise<unknown> | unknown;
}

export type AcpConnectionFactory = (
  options: AcpConnectionOptions,
) => Promise<AcpConnection>;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

interface JsonRpcErrorShape {
  code?: unknown;
  message?: unknown;
  data?: unknown;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const CLOSE_GRACE_MS = 1_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function rpcError(error: JsonRpcErrorShape): Error {
  const message =
    typeof error.message === "string" ? error.message : "fx ACP request failed";
  const code = typeof error.code === "number" ? ` (${error.code})` : "";
  const detail = error.data === undefined ? "" : `: ${JSON.stringify(error.data)}`;
  return new Error(`${message}${code}${detail}`);
}

export class FxAcpConnection implements AcpConnection {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #options: AcpConnectionOptions;
  readonly #pending = new Map<JsonRpcId, PendingRequest>();
  #nextId = 1;
  #stdoutBuffer = "";
  #stderr = "";
  #closing = false;
  #closed = false;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    options: AcpConnectionOptions,
  ) {
    this.#child = child;
    this.#options = options;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#handleStdout(chunk));
    child.stderr.on("data", (chunk: string) => {
      this.#stderr = `${this.#stderr}${chunk}`.slice(-16_384);
    });
    child.stdin.on("error", () => {
      // EPIPE during teardown is expected; process exit handles real failures.
    });
    child.once("error", (error) => this.#handleExit(error));
    child.once("exit", (code, signal) => {
      const stderr = this.#stderr.trim();
      const suffix = stderr ? `: ${stderr}` : "";
      this.#handleExit(
        new Error(
          `fx acp exited ${signal ? `with signal ${signal}` : `with code ${code ?? "unknown"}`}${suffix}`,
        ),
      );
    });
  }

  static async create(options: AcpConnectionOptions): Promise<FxAcpConnection> {
    const child = spawn("fx", ["acp"], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const connection = new FxAcpConnection(child, options);
    await new Promise<void>((resolve, reject) => {
      if (child.pid !== undefined) {
        resolve();
        return;
      }
      child.once("spawn", resolve);
      child.once("error", (error: NodeJS.ErrnoException) => {
        reject(
          error.code === "ENOENT"
            ? new Error(
                "The fx CLI was not found on PATH. Install fx and sign in with `fx login`.",
              )
            : error,
        );
      });
    });
    return connection;
  }

  request(
    method: string,
    params: unknown = {},
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (this.#closed || this.#closing) {
      return Promise.reject(new Error("fx ACP connection is closed"));
    }
    const id = this.#nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      if (timeoutMs > 0) {
        pending.timer = setTimeout(() => {
          this.#pending.delete(id);
          reject(new Error(`fx ACP ${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
      this.#pending.set(id, pending);
      this.#write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown = {}): void {
    if (this.#closed || this.#closing) return;
    this.#write({ jsonrpc: "2.0", method, params });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closing = true;
    this.#child.stdin.end();
    await this.#waitForExit(CLOSE_GRACE_MS);
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGTERM");
      await this.#waitForExit(CLOSE_GRACE_MS * 2);
    }
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill("SIGKILL");
      await this.#waitForExit(CLOSE_GRACE_MS * 2);
    }
    this.#closed = true;
    this.#rejectPending(new Error("fx ACP connection closed"));
  }

  #waitForExit(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
        resolve();
        return;
      }
      const timer = setTimeout(resolve, ms);
      this.#child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #write(message: unknown): void {
    if (this.#closed || this.#closing) return;
    this.#child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleStdout(chunk: string): void {
    this.#stdoutBuffer += chunk;
    while (true) {
      const newline = this.#stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#stdoutBuffer.slice(0, newline).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      void this.#handleMessage(message);
    }
  }

  async #handleMessage(value: unknown): Promise<void> {
    const message = asRecord(value);
    if (!message || message.jsonrpc !== "2.0") return;

    const hasId = typeof message.id === "string" || typeof message.id === "number";
    if (hasId && ("result" in message || "error" in message)) {
      const id = message.id as JsonRpcId;
      const pending = this.#pending.get(id);
      if (!pending) return;
      this.#pending.delete(id);
      if (pending.timer) clearTimeout(pending.timer);
      const error = asRecord(message.error);
      if (error) pending.reject(rpcError(error));
      else pending.resolve(message.result);
      return;
    }

    if (typeof message.method !== "string") return;
    if (hasId) {
      try {
        const result = this.#options.onRequest
          ? await this.#options.onRequest(message as unknown as JsonRpcRequest)
          : { outcome: { outcome: "cancelled" } };
        this.#write({ jsonrpc: "2.0", id: message.id, result });
      } catch (error) {
        this.#write({
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32603,
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
      return;
    }
    this.#options.onNotification(message as unknown as JsonRpcNotification);
  }

  #handleExit(error: Error): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending(error);
    if (!this.#closing) this.#options.onExit(error);
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

export const createFxAcpConnection: AcpConnectionFactory = (options) =>
  FxAcpConnection.create(options);
