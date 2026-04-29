import { extname, isAbsolute, resolve } from "node:path";
import { LspClient, type LspClientState } from "./client.js";
import { detectServers, type LspRole, type ServerSpec } from "./servers.js";

export type ManagedLspState = LspClientState | "skipped";

export interface ManagedLspServer {
  spec: ServerSpec;
  state: ManagedLspState;
  client?: LspClient;
  startedAt?: number;
}

export interface ReadyManagedLspServer extends ManagedLspServer {
  state: "ready";
  client: LspClient;
}

export interface ReadyLspServer extends ReadyManagedLspServer {
  absolutePath: string;
}

export interface LspStatusSnapshot {
  projectRoot: string;
  generation: number;
  servers: ManagedLspServer[];
}

export class LspManager {
  private projectRoot = "";
  private generation = 0;
  private servers: ManagedLspServer[] = [];
  private listeners = new Set<() => void>();

  start(projectRoot: string): void {
    this.shutdownNow();
    this.projectRoot = projectRoot;
    const generation = ++this.generation;
    const specs = detectServers(projectRoot);

    this.servers = specs.map((spec) => ({
      spec,
      state: spec.command ? "starting" : "skipped",
      startedAt: spec.command ? Date.now() : undefined,
    }));
    this.emit();

    for (const entry of this.servers) {
      if (!entry.spec.command) continue;

      const client = new LspClient(
        entry.spec.id,
        entry.spec.displayName,
        entry.spec.command,
        entry.spec.workspaceRoot,
        () => {
          if (generation !== this.generation) return;
          entry.state = client.getState();
          this.emit();
        },
      );

      entry.client = client;
      client.start();
    }
  }

  shutdownNow(): void {
    this.generation += 1;
    for (const entry of this.servers) {
      entry.client?.kill();
    }
    this.servers = [];
    this.projectRoot = "";
    this.emit();
  }

  snapshot(): LspStatusSnapshot {
    return {
      projectRoot: this.projectRoot,
      generation: this.generation,
      servers: [...this.servers],
    };
  }

  getReadyServersForFile(filePath: string): ReadyLspServer[] {
    return this.readyServersForFile(filePath);
  }

  getReadyDiagnosticsServersForFile(filePath: string): ReadyLspServer[] {
    return this.readyServersForFile(filePath, "diagnostics");
  }

  getReadyFormattersForFile(filePath: string): ReadyLspServer[] {
    return this.readyServersForFile(filePath, "format");
  }

  getReadyServer(id: string): ReadyManagedLspServer | undefined {
    const server = this.servers.find((server) => server.spec.id === id);
    if (!server || server.state !== "ready" || !server.client) return undefined;
    return { ...server, state: "ready", client: server.client };
  }

  getReadyServersByRole(role: LspRole): ReadyManagedLspServer[] {
    return this.servers.flatMap((server) => {
      if (server.state !== "ready" || !server.client || !server.spec.roles.includes(role)) return [];
      return [{ ...server, state: "ready" as const, client: server.client }];
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private readyServersForFile(filePath: string, role?: LspRole): ReadyLspServer[] {
    const absolutePath = this.resolveProjectPath(filePath);
    const extension = extname(absolutePath).toLowerCase();
    if (!extension) return [];

    return this.servers.flatMap((server) => {
      if (server.state !== "ready" || !server.client) return [];
      if (!server.spec.extensions.includes(extension)) return [];
      if (role && !server.spec.roles.includes(role)) return [];
      return [{ ...server, state: "ready" as const, client: server.client, absolutePath }];
    });
  }

  private resolveProjectPath(filePath: string): string {
    const stripped = filePath.replace(/^@/, "");
    return isAbsolute(stripped) ? stripped : resolve(this.projectRoot, stripped);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
