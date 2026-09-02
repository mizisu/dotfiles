import { Worker } from "node:worker_threads";
import type {
  CallOptions,
  ListToolsOptions,
  ServerDefinition,
  ServerToolInfo,
} from "mcporter";

const WORKER_URL = new URL("./runtime-worker.mjs", import.meta.url);
const WORKER_EXEC_ARGV = process.execArgv.filter((argument) => !argument.startsWith("--input-type"));
const BASE_ENV_KEYS = [
  "HOME",
  "USER",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
] as const;

interface WorkerReadyMessage {
  type: "ready";
  definitions?: unknown[];
}

interface WorkerErrorMessage {
  type: "init-error";
  error: string;
}

interface WorkerResultMessage {
  type: "result";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface WorkerCancelledMessage {
  type: "cancelled";
}

type WorkerMessage = WorkerReadyMessage | WorkerErrorMessage | WorkerResultMessage | WorkerCancelledMessage;

type WireDefinition = Omit<ServerDefinition, "command"> & {
  command:
    | { kind: "stdio"; command: string; args: string[]; cwd: string }
    | { kind: "http"; url: string; headers?: Record<string, string> };
};

export interface IsolatedRuntime {
  listServers(): Promise<string[]>;
  getDefinitions(): Promise<ServerDefinition[]>;
  listTools(server: string, options?: ListToolsOptions, signal?: AbortSignal): Promise<ServerToolInfo[]>;
  callTool(server: string, toolName: string, options?: CallOptions, signal?: AbortSignal): Promise<unknown>;
  authorizeServer(server: string, reset: boolean): Promise<ServerToolInfo[]>;
  close(server?: string): Promise<void>;
}

function sanitizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function copyEnv(keys?: Iterable<string>, overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  const selectedKeys = keys ?? new Set([...Object.keys(process.env), ...Object.keys(overrides)]);

  for (const key of selectedKeys) {
    const value = overrides[key] ?? process.env[key];
    if (value !== undefined) env[key] = value;
  }

  return env;
}

function serializeDefinition(definition: ServerDefinition): WireDefinition {
  if (definition.command.kind === "http") {
    return {
      ...definition,
      command: {
        ...definition.command,
        url: definition.command.url.toString(),
      },
    };
  }

  return definition as WireDefinition;
}

function deserializeDefinition(raw: unknown): ServerDefinition {
  if (!raw || typeof raw !== "object") throw new Error("Invalid MCP server definition from isolated loader.");
  const wire = raw as WireDefinition;
  if (!wire.command || typeof wire.command !== "object") throw new Error("MCP server definition has no command.");

  if (wire.command.kind === "http") {
    return {
      ...wire,
      command: {
        ...wire.command,
        url: new URL(wire.command.url),
      },
    } as ServerDefinition;
  }

  return wire as ServerDefinition;
}

function collectPlaceholderNames(value: unknown, names: Set<string>): void {
  if (typeof value === "string") {
    if (value.startsWith("$env:")) {
      const name = value.slice(5);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) names.add(name);
    }

    const pattern = /(^|[^\\])\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}/g;
    for (const match of value.matchAll(pattern)) names.add(match[2]!);
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) collectPlaceholderNames(entry, names);
    return;
  }

  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectPlaceholderNames(entry, names);
  }
}

function referencedEnvNames(definition: ServerDefinition): Set<string> {
  const names = new Set<string>();
  collectPlaceholderNames(definition, names);

  if (definition.oauthClientSecretEnv) names.add(definition.oauthClientSecretEnv);
  if (definition.refresh?.clientIdEnv) names.add(definition.refresh.clientIdEnv);
  if (definition.refresh?.clientSecretEnv) names.add(definition.refresh.clientSecretEnv);
  if (definition.refresh?.accessTokenEnv) names.add(definition.refresh.accessTokenEnv);
  return names;
}

function workerEnvForServer(definition: ServerDefinition, extensionEnv: Record<string, string>): NodeJS.ProcessEnv {
  const keys = new Set<string>(BASE_ENV_KEYS);
  for (const name of referencedEnvNames(definition)) keys.add(name);
  return copyEnv(keys, extensionEnv);
}

function loadDefinitions(rootDir: string, extensionEnv: Record<string, string>): Promise<ServerDefinition[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_URL, {
      workerData: { mode: "catalog", rootDir },
      // Config interpolation needs the complete parent environment plus the
      // extension-local values. This worker only parses configuration and never
      // starts an MCP server.
      env: copyEnv(undefined, extensionEnv),
      execArgv: WORKER_EXEC_ARGV,
    });
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("MCP config worker initialization timed out.")), 15_000);
    timeout.unref();

    const finish = (error?: Error, definitions?: ServerDefinition[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void worker.terminate();
      if (error) reject(error);
      else resolve(definitions ?? []);
    };

    worker.on("message", (message: WorkerMessage) => {
      if (message.type === "ready") {
        try {
          finish(undefined, (message.definitions ?? []).map(deserializeDefinition));
        } catch (error) {
          finish(new Error(sanitizeError(error)));
        }
      } else if (message.type === "init-error") {
        finish(new Error(message.error));
      }
    });
    worker.once("error", (error) => finish(error));
    worker.once("exit", (code) => {
      if (!settled) finish(new Error(`MCP config worker exited before initialization (code ${code}).`));
    });
  });
}

interface RequestOptions {
  signal?: AbortSignal;
  timeoutMs: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class ServerWorker {
  private readonly worker: Worker;
  private readonly ready: Promise<void>;
  private readonly startupTimeout: NodeJS.Timeout;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private nextId = 1;
  private closing = false;
  private abortTimeout: NodeJS.Timeout | undefined;
  private failure: Error | undefined;
  private pending = new Map<number, PendingRequest>();

  constructor(definition: ServerDefinition, rootDir: string, extensionEnv: Record<string, string>) {
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker = new Worker(WORKER_URL, {
      workerData: { mode: "server", rootDir, definition: serializeDefinition(definition) },
      env: workerEnvForServer(definition, extensionEnv),
      execArgv: WORKER_EXEC_ARGV,
    });

    this.startupTimeout = setTimeout(() => {
      this.abortWorker(new Error("MCP server worker initialization timed out."));
    }, 15_000);
    this.startupTimeout.unref();

    this.worker.on("message", (message: WorkerMessage) => this.handleMessage(message));
    this.worker.once("error", (error) => this.fail(error));
    this.worker.once("exit", (code) => {
      if (this.abortTimeout) clearTimeout(this.abortTimeout);
      if (!this.closing) this.fail(new Error(`MCP server worker exited unexpectedly with code ${code}.`));
    });
  }

  isUsable(): boolean {
    return !this.closing && !this.failure;
  }

  async request<T>(method: string, args: unknown[] = [], options: RequestOptions): Promise<T> {
    const signal = options.signal;
    if (signal?.aborted) {
      const error = new Error("MCP request aborted.");
      this.abortWorker(error);
      throw error;
    }

    let readyAbort: (() => void) | undefined;
    try {
      await Promise.race([
        this.ready,
        new Promise<never>((_resolve, reject) => {
          if (!signal) return;
          readyAbort = () => {
            const error = new Error("MCP request aborted.");
            this.abortWorker(error);
            reject(error);
          };
          signal.addEventListener("abort", readyAbort, { once: true });
        }),
      ]);
    } finally {
      if (readyAbort) signal?.removeEventListener("abort", readyAbort);
    }

    if (this.failure) throw this.failure;
    if (this.closing) throw new Error("MCP server worker is closing.");

    const id = this.nextId++;
    const result = new Promise<T>((resolve, reject) => {
      let timeout: NodeJS.Timeout | undefined;
      const abort = () => this.abortWorker(new Error("MCP request aborted."));
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener("abort", abort);
      };

      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value as T);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => {
        this.abortWorker(new Error(`MCP request timed out after ${options.timeoutMs}ms.`));
      }, options.timeoutMs);
      timeout.unref();
    });
    this.worker.postMessage({ type: "request", id, method, args });
    return result;
  }

  async close(): Promise<void> {
    if (this.closing) return;
    let timeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.request("close", [], { timeoutMs: 1_500 }).catch(() => undefined),
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, 1_500);
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      this.closing = true;
      if (this.abortTimeout) clearTimeout(this.abortTimeout);
      await this.worker.terminate();
      this.fail(new Error("MCP server worker closed."));
    }
  }

  private handleMessage(message: WorkerMessage): void {
    if (message.type === "ready") {
      clearTimeout(this.startupTimeout);
      this.resolveReady();
      return;
    }
    if (message.type === "init-error") {
      this.fail(new Error(message.error));
      return;
    }
    if (message.type === "cancelled") {
      if (this.abortTimeout) clearTimeout(this.abortTimeout);
      void this.worker.terminate();
      return;
    }
    if (message.type !== "result") return;

    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error ?? "Unknown MCP worker error."));
  }

  private abortWorker(error: Error): void {
    if (this.closing) return;
    this.closing = true;
    this.fail(error);
    this.worker.postMessage({ type: "cancel" });
    this.abortTimeout = setTimeout(() => {
      void this.worker.terminate();
    }, 1_500);
    this.abortTimeout.unref();
  }

  private fail(error: Error): void {
    clearTimeout(this.startupTimeout);
    if (!this.failure) {
      this.failure = error;
      this.rejectReady(error);
    }
    for (const pending of this.pending.values()) pending.reject(this.failure);
    this.pending.clear();
  }
}

export class McpIsolatedRuntime implements IsolatedRuntime {
  private definitions: ServerDefinition[] = [];
  private definitionsByName = new Map<string, ServerDefinition>();
  private workers = new Map<string, ServerWorker>();

  constructor(
    private readonly rootDir: string,
    private readonly extensionEnv: Record<string, string>,
  ) {}

  async initialize(): Promise<this> {
    this.definitions = await loadDefinitions(this.rootDir, this.extensionEnv);
    this.definitionsByName = new Map(this.definitions.map((definition) => [definition.name, definition]));
    return this;
  }

  async listServers(): Promise<string[]> {
    return [...this.definitionsByName.keys()].sort((a, b) => a.localeCompare(b));
  }

  async getDefinitions(): Promise<ServerDefinition[]> {
    return [...this.definitions];
  }

  async listTools(server: string, options?: ListToolsOptions, signal?: AbortSignal): Promise<ServerToolInfo[]> {
    return this.getWorker(server).request("listTools", [server, options], { signal, timeoutMs: 60_000 });
  }

  async callTool(server: string, toolName: string, options?: CallOptions, signal?: AbortSignal): Promise<unknown> {
    const timeoutMs = options?.timeoutMs ?? 60_000;
    return this.getWorker(server).request("callTool", [server, toolName, options], { signal, timeoutMs });
  }

  async authorizeServer(server: string, reset: boolean): Promise<ServerToolInfo[]> {
    return this.getWorker(server).request("authorize", [server, reset], { timeoutMs: 300_000 });
  }

  async close(server?: string): Promise<void> {
    if (server) {
      const worker = this.workers.get(server);
      this.workers.delete(server);
      await worker?.close();
      return;
    }

    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.allSettled(workers.map((worker) => worker.close()));
  }

  private getWorker(server: string): ServerWorker {
    const definition = this.definitionsByName.get(server);
    if (!definition) throw new Error(`Unknown MCP server '${server}'.`);

    let worker = this.workers.get(server);
    if (worker && !worker.isUsable()) {
      this.workers.delete(server);
      worker = undefined;
    }
    if (!worker) {
      worker = new ServerWorker(definition, this.rootDir, this.extensionEnv);
      this.workers.set(server, worker);
    }
    return worker;
  }
}
