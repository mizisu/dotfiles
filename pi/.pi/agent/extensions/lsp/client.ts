import { spawn, ChildProcess } from "node:child_process";
import * as rpc from "vscode-jsonrpc/node";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";

export interface Diagnostic {
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
}

export interface Location {
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

// LSP SymbolKind → human-readable label
const SYMBOL_KIND: Record<number, string> = {
  1: "File", 2: "Module", 3: "Namespace", 4: "Package",
  5: "Class", 6: "Method", 7: "Property", 8: "Field",
  9: "Constructor", 10: "Enum", 11: "Interface", 12: "Function",
  13: "Variable", 14: "Constant", 15: "String", 16: "Number",
  17: "Boolean", 18: "Array", 19: "Object", 20: "Key",
  21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event",
  25: "Operator", 26: "TypeParameter",
};

export interface WorkspaceSymbol {
  name: string;
  kind: string;
  file: string;
  line: number;
  character: number;
  containerName?: string;
}

export type WatchedFileChangeType = "created" | "changed" | "deleted";

export interface WatchedFileChange {
  path: string;
  type: WatchedFileChangeType;
}

const SEVERITY_MAP: Record<number, Diagnostic["severity"]> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace("file://", ""));
}

function pathToUri(p: string): string {
  return `file://${resolve(p)}`;
}

function parseLoc(loc: any): Location {
  // Handle both Location and LocationLink
  if (loc.targetUri) {
    return {
      file: uriToPath(loc.targetUri),
      line: loc.targetRange.start.line + 1,
      character: loc.targetRange.start.character,
      endLine: loc.targetRange.end.line + 1,
      endCharacter: loc.targetRange.end.character,
    };
  }
  return {
    file: uriToPath(loc.uri),
    line: loc.range.start.line + 1,
    character: loc.range.start.character,
    endLine: loc.range.end.line + 1,
    endCharacter: loc.range.end.character,
  };
}

export class LSPClient {
  private connection: rpc.MessageConnection;
  private process: ChildProcess;
  private diagnostics = new Map<string, Diagnostic[]>();
  private openFiles = new Set<string>();
  private fileVersions = new Map<string, number>();
  private ready = false;
  private dead = false;
  private initPromise: Promise<void>;
  public readonly language: string;

  constructor(
    public readonly name: string,
    command: string,
    args: string[],
    private workspaceRoot: string,
    language: string,
    env?: Record<string, string>,
    private settings?: Record<string, any>,
  ) {
    this.language = language;

    this.process = spawn(command, args, {
      stdio: "pipe",
      cwd: workspaceRoot,
      env: { ...process.env, ...env },
    });

    // Swallow write-after-destroy errors on stdin
    this.process.stdin?.on("error", () => {});
    this.process.stdout?.on("error", () => {});

    this.process.on("exit", () => {
      this.dead = true;
      this.ready = false;
      try { this.connection.dispose(); } catch {}
    });

    this.process.stderr?.on("data", () => {
      // Suppress. Uncomment for debugging:
      // process.stderr.write(`[${name}] ${data}`);
    });

    this.connection = rpc.createMessageConnection(
      new rpc.StreamMessageReader(this.process.stdout!),
      new rpc.StreamMessageWriter(this.process.stdin!),
    );

    // Listen for push diagnostics
    this.connection.onNotification(
      "textDocument/publishDiagnostics",
      (params: any) => {
        const filePath = uriToPath(params.uri);
        this.diagnostics.set(
          filePath,
          (params.diagnostics ?? []).map((d: any) => ({
            file: filePath,
            line: d.range.start.line + 1,
            character: d.range.start.character,
            endLine: d.range.end.line + 1,
            endCharacter: d.range.end.character,
            severity: SEVERITY_MAP[d.severity ?? 3] ?? "info",
            message: d.message,
            source: d.source,
          })),
        );
      },
    );

    // Handle workspace/configuration requests (pull model, used by pyright)
    this.connection.onRequest("workspace/configuration", (params: any) => {
      return (params.items ?? []).map((item: any) => {
        if (!this.settings) return {};
        if (!item.section) return this.settings;
        return item.section.split(".").reduce((obj: any, key: string) => obj?.[key], this.settings) ?? {};
      });
    });

    this.connection.onError(() => {});
    this.connection.onClose(() => {
      this.dead = true;
      this.ready = false;
    });
    this.connection.onUnhandledNotification(() => {});

    this.connection.listen();
    this.initPromise = this.initialize();
  }

  /**
   * Use raw string methods to avoid byName/byPosition parameter structure issues
   * with pyrefly and typescript-language-server.
   */
  private async initialize(): Promise<void> {
    try {
      await this.connection.sendRequest("initialize", {
        processId: process.pid,
        rootUri: pathToUri(this.workspaceRoot),
        workspaceFolders: [
          { uri: pathToUri(this.workspaceRoot), name: this.name },
        ],
        capabilities: {
          textDocument: {
            synchronization: {
              dynamicRegistration: false,
              willSave: false,
              didSave: true,
              willSaveWaitUntil: false,
            },
            definition: { dynamicRegistration: false, linkSupport: true },
            references: { dynamicRegistration: false },
            hover: {
              dynamicRegistration: false,
              contentFormat: ["plaintext", "markdown"],
            },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: { valueSet: [1, 2] },
            },
          },
          workspace: {
            workspaceFolders: true,
            symbol: { dynamicRegistration: false },
            didChangeWatchedFiles: {
              dynamicRegistration: false,
              relativePatternSupport: false,
            },
          },
        },
      });

      this.connection.sendNotification("initialized", {});

      if (this.settings) {
        this.connection.sendNotification("workspace/didChangeConfiguration", {
          settings: this.settings,
        });
      }

      this.ready = true;

      // Auto-open an entry file so tsserver creates a project
      // (required for workspace/symbol to work)
      await this.openEntryFile();
    } catch (e) {
      this.dead = true;
      throw new Error(`[${this.name}] LSP init failed: ${e}`);
    }
  }

  /**
   * Open a representative file so the LSP server indexes the project.
   * tsserver needs at least one open file to create a "project".
   */
  private async openEntryFile(): Promise<void> {
    const { existsSync } = await import("node:fs");
    const candidates = this.language === "typescript"
      ? ["src/index.tsx", "src/index.ts", "src/App.tsx", "src/main.tsx", "src/main.ts"]
      : ["manage.py", "app.py", "main.py", "__init__.py"];

    for (const c of candidates) {
      const abs = resolve(this.workspaceRoot, c);
      if (existsSync(abs)) {
        await this.ensureOpen(abs);
        return;
      }
    }
  }

  async waitReady(): Promise<void> {
    await this.initPromise;
  }

  isAlive(): boolean {
    return !this.dead && this.ready;
  }

  private inferLanguageId(filePath: string): string {
    if (this.language === "python") return "python";
    const ext = extname(filePath);
    if (ext === ".tsx" || ext === ".jsx") return "typescriptreact";
    if (ext === ".js") return "javascript";
    return "typescript";
  }

  private async ensureOpen(filePath: string): Promise<void> {
    const abs = resolve(filePath);
    if (this.openFiles.has(abs)) return;
    try {
      const content = await readFile(abs, "utf-8");
      this.fileVersions.set(abs, 1);
      await this.connection.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: pathToUri(abs),
          languageId: this.inferLanguageId(abs),
          version: 1,
          text: content,
        },
      }).catch(() => {});
      this.openFiles.add(abs);
    } catch {
      // file may not exist
    }
  }

  private async closeIfOpen(filePath: string): Promise<void> {
    const abs = resolve(filePath);
    if (!this.openFiles.has(abs)) {
      this.fileVersions.delete(abs);
      this.diagnostics.delete(abs);
      return;
    }

    await this.connection.sendNotification("textDocument/didClose", {
      textDocument: { uri: pathToUri(abs) },
    }).catch(() => {});

    this.openFiles.delete(abs);
    this.fileVersions.delete(abs);
    this.diagnostics.delete(abs);
  }

  async notifyChanged(filePath: string): Promise<void> {
    if (this.dead || !this.ready) return;
    const abs = resolve(filePath);
    try {
      const content = await readFile(abs, "utf-8");
      const version = (this.fileVersions.get(abs) ?? 1) + 1;
      this.fileVersions.set(abs, version);

      if (this.openFiles.has(abs)) {
        await this.connection.sendNotification("textDocument/didChange", {
          textDocument: { uri: pathToUri(abs), version },
          contentChanges: [{ text: content }],
        }).catch(() => {});
      } else {
        await this.ensureOpen(abs);
      }

      await this.connection.sendNotification("textDocument/didSave", {
        textDocument: { uri: pathToUri(abs) },
        text: content,
      }).catch(() => {});
    } catch {
      // file deleted
    }
  }

  async notifyWatchedFilesChanged(changes: WatchedFileChange[]): Promise<void> {
    if (this.dead || !this.ready || changes.length === 0) return;

    const normalized = changes.map((c) => ({
      path: resolve(c.path),
      type: c.type,
    }));

    await Promise.all(
      normalized
        .filter((c) => c.type === "deleted")
        .map((c) => this.closeIfOpen(c.path)),
    );

    const kindMap: Record<WatchedFileChangeType, number> = {
      created: 1,
      changed: 2,
      deleted: 3,
    };

    await this.connection.sendNotification("workspace/didChangeWatchedFiles", {
      changes: normalized.map((c) => ({
        uri: pathToUri(c.path),
        type: kindMap[c.type],
      })),
    }).catch(() => {});
  }

  async definition(
    filePath: string,
    line: number,
    character: number,
  ): Promise<Location[]> {
    await this.waitReady();
    const abs = resolve(filePath);
    await this.ensureOpen(abs);

    const result: any = await this.connection.sendRequest(
      "textDocument/definition",
      {
        textDocument: { uri: pathToUri(abs) },
        position: { line: line - 1, character },
      },
    );
    if (!result) return [];

    const items = Array.isArray(result) ? result : [result];
    return items.map(parseLoc);
  }

  async references(
    filePath: string,
    line: number,
    character: number,
    includeDeclaration = true,
  ): Promise<Location[]> {
    await this.waitReady();
    const abs = resolve(filePath);
    await this.ensureOpen(abs);

    const result: any = await this.connection.sendRequest(
      "textDocument/references",
      {
        textDocument: { uri: pathToUri(abs) },
        position: { line: line - 1, character },
        context: { includeDeclaration },
      },
    );
    return (result ?? []).map(parseLoc);
  }

  async hover(
    filePath: string,
    line: number,
    character: number,
  ): Promise<string | null> {
    await this.waitReady();
    const abs = resolve(filePath);
    await this.ensureOpen(abs);

    const result: any = await this.connection.sendRequest(
      "textDocument/hover",
      {
        textDocument: { uri: pathToUri(abs) },
        position: { line: line - 1, character },
      },
    );
    if (!result?.contents) return null;

    const c = result.contents;
    if (typeof c === "string") return c;
    if ("value" in c) return c.value;
    if (Array.isArray(c))
      return c.map((x: any) => (typeof x === "string" ? x : x.value)).join("\n\n");
    return null;
  }

  async workspaceSymbol(query: string): Promise<WorkspaceSymbol[]> {
    await this.waitReady();

    try {
      const result: any = await this.connection.sendRequest(
        "workspace/symbol",
        { query },
      );
      if (!result || !Array.isArray(result)) return [];

      return result.map((s: any) => ({
        name: s.name,
        kind: SYMBOL_KIND[s.kind] ?? `Unknown(${s.kind})`,
        file: s.location?.uri ? uriToPath(s.location.uri) : "",
        line: (s.location?.range?.start?.line ?? 0) + 1,
        character: s.location?.range?.start?.character ?? 0,
        containerName: s.containerName || undefined,
      }));
    } catch {
      return [];
    }
  }

  getDiagnostics(filePath: string): Diagnostic[] {
    return this.diagnostics.get(resolve(filePath)) ?? [];
  }

  getErrorDiagnostics(filePath: string): Diagnostic[] {
    return this.getDiagnostics(filePath).filter((d) => d.severity === "error");
  }

  async shutdown(): Promise<void> {
    if (this.dead) return;
    this.dead = true;
    this.ready = false;
    try {
      // Send shutdown request, then exit notification, before killing
      await Promise.race([
        this.connection.sendRequest("shutdown").then(() => {
          return this.connection.sendNotification("exit").catch(() => {});
        }),
        new Promise<void>((r) => setTimeout(r, 3000)),
      ]);
    } catch {
      // already dead
    }
    // Dispose connection first, then kill process
    try { this.connection.end(); } catch {}
    try { this.connection.dispose(); } catch {}
    // Destroy stdin to prevent further writes before killing
    try { this.process.stdin?.destroy(); } catch {}
    try { this.process.kill(); } catch {}
  }
}
