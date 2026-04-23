import { spawn, ChildProcess } from "node:child_process";
import * as rpc from "vscode-jsonrpc/node";
import { readFile, writeFile } from "node:fs/promises";
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

const LSP_SEVERITY: Record<Diagnostic["severity"], number> = {
  error: 1,
  warning: 2,
  info: 3,
  hint: 4,
};

function uriToPath(uri: string): string {
  return decodeURIComponent(uri.replace("file://", ""));
}

function pathToUri(path: string): string {
  return `file://${resolve(path)}`;
}

function parseLoc(loc: any): Location {
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

function parseDiagnostic(filePath: string, diagnostic: any): Diagnostic {
  return {
    file: filePath,
    line: diagnostic.range.start.line + 1,
    character: diagnostic.range.start.character,
    endLine: diagnostic.range.end.line + 1,
    endCharacter: diagnostic.range.end.character,
    severity: SEVERITY_MAP[diagnostic.severity ?? 3] ?? "info",
    message: diagnostic.message,
    source: diagnostic.source,
  };
}

function positionToOffset(text: string, line: number, character: number): number {
  if (line <= 0) return Math.max(character, 0);

  let offset = 0;
  let currentLine = 0;
  while (currentLine < line && offset < text.length) {
    const next = text.indexOf("\n", offset);
    if (next === -1) return text.length;
    offset = next + 1;
    currentLine += 1;
  }

  return Math.min(offset + character, text.length);
}

function applyTextEdits(text: string, edits: any[]): string {
  const sorted = [...edits].sort((a, b) => {
    const aStart = positionToOffset(text, a.range.start.line, a.range.start.character);
    const bStart = positionToOffset(text, b.range.start.line, b.range.start.character);
    if (aStart !== bStart) return bStart - aStart;
    const aEnd = positionToOffset(text, a.range.end.line, a.range.end.character);
    const bEnd = positionToOffset(text, b.range.end.line, b.range.end.character);
    return bEnd - aEnd;
  });

  let nextText = text;
  for (const edit of sorted) {
    const start = positionToOffset(nextText, edit.range.start.line, edit.range.start.character);
    const end = positionToOffset(nextText, edit.range.end.line, edit.range.end.character);
    nextText = `${nextText.slice(0, start)}${edit.newText ?? ""}${nextText.slice(end)}`;
  }

  return nextText;
}

async function getDocumentRange(filePath: string): Promise<{ start: { line: number; character: number }; end: { line: number; character: number } }> {
  const content = await readFile(filePath, "utf-8");
  const lines = content.split("\n");
  const lastLine = lines.length - 1;
  const lastCharacter = lines[lastLine]?.length ?? 0;
  return {
    start: { line: 0, character: 0 },
    end: { line: lastLine, character: lastCharacter },
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
  private serverCapabilities: any = {};
  public readonly language: string;

  constructor(
    public readonly name: string,
    command: string,
    args: string[],
    private workspaceRoot: string,
    language: string,
    env?: Record<string, string>,
    private settings?: Record<string, any>,
    private sendDidSave = true,
  ) {
    this.language = language;

    this.process = spawn(command, args, {
      stdio: "pipe",
      cwd: workspaceRoot,
      env: { ...process.env, ...env },
    });

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

    this.connection.onNotification("textDocument/publishDiagnostics", (params: any) => {
      const filePath = uriToPath(params.uri);
      this.diagnostics.set(
        filePath,
        (params.diagnostics ?? []).map((diagnostic: any) => parseDiagnostic(filePath, diagnostic)),
      );
    });

    this.connection.onRequest("workspace/configuration", (params: any) => {
      return (params.items ?? []).map((item: any) => {
        if (!this.settings) return {};
        if (!item.section) return this.settings;
        return item.section.split(".").reduce((obj: any, key: string) => obj?.[key], this.settings) ?? {};
      });
    });

    this.connection.onRequest("workspace/applyEdit", async (params: any) => {
      const applied = await this.applyWorkspaceEdit(params?.edit);
      return { applied };
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

  private async initialize(): Promise<void> {
    try {
      const result: any = await this.connection.sendRequest("initialize", {
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
            formatting: { dynamicRegistration: false },
            codeAction: {
              dynamicRegistration: false,
              dataSupport: true,
              resolveSupport: { properties: ["edit", "command"] },
              codeActionLiteralSupport: {
                codeActionKind: {
                  valueSet: ["quickfix", "source.fixAll", "source.organizeImports"],
                },
              },
            },
            diagnostic: {
              dynamicRegistration: false,
              relatedDocumentSupport: false,
            },
            publishDiagnostics: {
              relatedInformation: true,
              tagSupport: { valueSet: [1, 2] },
            },
          },
          workspace: {
            workspaceFolders: true,
            applyEdit: true,
            executeCommand: { dynamicRegistration: false },
            symbol: { dynamicRegistration: false },
            didChangeWatchedFiles: {
              dynamicRegistration: false,
              relativePatternSupport: false,
            },
          },
        },
      });

      if (this.dead) return;
      this.serverCapabilities = result?.capabilities ?? {};
      await this.connection.sendNotification("initialized", {}).catch(() => {});
      if (this.dead) return;

      if (this.settings) {
        await this.connection.sendNotification("workspace/didChangeConfiguration", {
          settings: this.settings,
        }).catch(() => {});
        if (this.dead) return;
      }

      this.ready = true;
      await this.openEntryFile();
    } catch (e) {
      if (this.dead) return;
      this.dead = true;
      throw new Error(`[${this.name}] LSP init failed: ${e}`);
    }
  }

  private async openEntryFile(): Promise<void> {
    const { existsSync } = await import("node:fs");
    const candidates = this.language === "python"
      ? ["manage.py", "app.py", "main.py", "__init__.py"]
      : this.language === "css"
        ? ["src/index.css", "src/main.css", "src/app.css", "styles.css"]
        : ["src/index.tsx", "src/index.ts", "src/App.tsx", "src/main.tsx", "src/main.ts"];

    for (const candidate of candidates) {
      const absPath = resolve(this.workspaceRoot, candidate);
      if (existsSync(absPath)) {
        await this.ensureOpen(absPath);
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

  private supportsPullDiagnostics(): boolean {
    return !!this.serverCapabilities?.diagnosticProvider;
  }

  private supportsFormatting(): boolean {
    return !!this.serverCapabilities?.documentFormattingProvider;
  }

  private supportsCodeActions(): boolean {
    return !!this.serverCapabilities?.codeActionProvider;
  }

  private supportsCodeActionResolve(): boolean {
    return typeof this.serverCapabilities?.codeActionProvider === "object" && !!this.serverCapabilities.codeActionProvider.resolveProvider;
  }

  private inferLanguageId(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    if (this.language === "python" || ext === ".py" || ext === ".pyi") return "python";
    if (ext === ".tsx") return "typescriptreact";
    if (ext === ".jsx") return "javascriptreact";
    if (ext === ".js") return "javascript";
    if (ext === ".css") return "css";
    if (ext === ".scss") return "scss";
    if (ext === ".sass") return "sass";
    if (ext === ".less") return "less";
    if (ext === ".json") return "json";
    return "typescript";
  }

  private async ensureOpen(filePath: string): Promise<void> {
    const absPath = resolve(filePath);
    if (this.openFiles.has(absPath)) return;
    try {
      const content = await readFile(absPath, "utf-8");
      this.fileVersions.set(absPath, 1);
      await this.connection.sendNotification("textDocument/didOpen", {
        textDocument: {
          uri: pathToUri(absPath),
          languageId: this.inferLanguageId(absPath),
          version: 1,
          text: content,
        },
      }).catch(() => {});
      this.openFiles.add(absPath);
    } catch {
      // file may not exist
    }
  }

  private async closeIfOpen(filePath: string): Promise<void> {
    const absPath = resolve(filePath);
    if (!this.openFiles.has(absPath)) {
      this.fileVersions.delete(absPath);
      this.diagnostics.delete(absPath);
      return;
    }

    await this.connection.sendNotification("textDocument/didClose", {
      textDocument: { uri: pathToUri(absPath) },
    }).catch(() => {});

    this.openFiles.delete(absPath);
    this.fileVersions.delete(absPath);
    this.diagnostics.delete(absPath);
  }

  async notifyChanged(filePath: string): Promise<void> {
    if (this.dead || !this.ready) return;
    const absPath = resolve(filePath);
    try {
      const content = await readFile(absPath, "utf-8");
      const version = (this.fileVersions.get(absPath) ?? 1) + 1;
      this.fileVersions.set(absPath, version);

      if (this.openFiles.has(absPath)) {
        await this.connection.sendNotification("textDocument/didChange", {
          textDocument: { uri: pathToUri(absPath), version },
          contentChanges: [{ text: content }],
        }).catch(() => {});
      } else {
        await this.ensureOpen(absPath);
      }

      if (this.sendDidSave) {
        await this.connection.sendNotification("textDocument/didSave", {
          textDocument: { uri: pathToUri(absPath) },
        }).catch(() => {});
      }
    } catch {
      // file deleted
    }
  }

  async notifyWatchedFilesChanged(changes: WatchedFileChange[]): Promise<void> {
    if (this.dead || !this.ready || changes.length === 0) return;

    const normalized = changes.map((change) => ({
      path: resolve(change.path),
      type: change.type,
    }));

    await Promise.all(
      normalized
        .filter((change) => change.type === "deleted")
        .map((change) => this.closeIfOpen(change.path)),
    );

    const kindMap: Record<WatchedFileChangeType, number> = {
      created: 1,
      changed: 2,
      deleted: 3,
    };

    await this.connection.sendNotification("workspace/didChangeWatchedFiles", {
      changes: normalized.map((change) => ({
        uri: pathToUri(change.path),
        type: kindMap[change.type],
      })),
    }).catch(() => {});
  }

  async refreshDiagnostics(filePath: string, waitMs = 0): Promise<Diagnostic[]> {
    await this.waitReady();
    const absPath = resolve(filePath);
    await this.ensureOpen(absPath);

    if (waitMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    if (!this.supportsPullDiagnostics()) {
      return this.getDiagnostics(absPath);
    }

    try {
      const result: any = await this.connection.sendRequest("textDocument/diagnostic", {
        textDocument: { uri: pathToUri(absPath) },
      });

      if (Array.isArray(result?.items)) {
        this.diagnostics.set(
          absPath,
          result.items.map((diagnostic: any) => parseDiagnostic(absPath, diagnostic)),
        );
      }
    } catch {
      // fall back to the latest pushed diagnostics
    }

    return this.getDiagnostics(absPath);
  }

  private async applyTextDocumentEdits(filePath: string, edits: any[]): Promise<boolean> {
    if (!Array.isArray(edits) || edits.length === 0) return false;

    const absPath = resolve(filePath);
    const original = await readFile(absPath, "utf-8");
    const updated = applyTextEdits(original, edits);
    if (updated === original) return false;

    await writeFile(absPath, updated, "utf-8");
    await this.notifyChanged(absPath);
    return true;
  }

  private async applyWorkspaceEdit(edit: any): Promise<boolean> {
    if (!edit) return false;

    const editsByFile = new Map<string, any[]>();

    for (const [uri, edits] of Object.entries(edit.changes ?? {})) {
      if (!Array.isArray(edits)) continue;
      editsByFile.set(uriToPath(uri), edits);
    }

    for (const change of edit.documentChanges ?? []) {
      if (!change?.textDocument?.uri || !Array.isArray(change.edits)) continue;
      const filePath = uriToPath(change.textDocument.uri);
      editsByFile.set(filePath, [...(editsByFile.get(filePath) ?? []), ...change.edits]);
    }

    let changed = false;
    for (const [filePath, edits] of editsByFile.entries()) {
      changed = (await this.applyTextDocumentEdits(filePath, edits)) || changed;
    }

    return changed;
  }

  async formatDocument(filePath: string): Promise<boolean> {
    await this.waitReady();
    if (!this.supportsFormatting()) {
      throw new Error(`${this.name} does not support document formatting.`);
    }

    const absPath = resolve(filePath);
    await this.ensureOpen(absPath);

    const edits: any = await this.connection.sendRequest("textDocument/formatting", {
      textDocument: { uri: pathToUri(absPath) },
      options: {
        tabSize: 2,
        insertSpaces: true,
        trimTrailingWhitespace: true,
        insertFinalNewline: true,
        trimFinalNewlines: true,
      },
    });

    return this.applyTextDocumentEdits(absPath, edits ?? []);
  }

  private async executeCommand(command: string, args?: any[]): Promise<boolean> {
    if (!command) return false;
    await this.connection.sendRequest("workspace/executeCommand", {
      command,
      arguments: args ?? [],
    });
    return true;
  }

  private async applyCodeAction(action: any): Promise<boolean> {
    if (!action) return false;

    if (typeof action.command === "string") {
      return this.executeCommand(action.command, action.arguments);
    }

    let resolved = action;
    if (!resolved.edit && !resolved.command && resolved.data && this.supportsCodeActionResolve()) {
      try {
        resolved = await this.connection.sendRequest("codeAction/resolve", resolved);
      } catch {
        resolved = action;
      }
    }

    let changed = false;
    if (resolved.edit) {
      changed = (await this.applyWorkspaceEdit(resolved.edit)) || changed;
    }
    if (resolved.command?.command) {
      changed = (await this.executeCommand(resolved.command.command, resolved.command.arguments)) || changed;
    }

    return changed;
  }

  async applyCodeActionKinds(filePath: string, kinds: string[]): Promise<boolean> {
    await this.waitReady();
    if (!this.supportsCodeActions()) {
      throw new Error(`${this.name} does not support code actions.`);
    }

    const absPath = resolve(filePath);
    await this.ensureOpen(absPath);
    let changed = false;

    for (const kind of kinds) {
      const range = await getDocumentRange(absPath);
      const diagnostics = await this.refreshDiagnostics(absPath, 200);
      const actions: any = await this.connection.sendRequest("textDocument/codeAction", {
        textDocument: { uri: pathToUri(absPath) },
        range,
        context: {
          diagnostics: diagnostics.map((diagnostic) => ({
            range: {
              start: { line: diagnostic.line - 1, character: diagnostic.character },
              end: { line: diagnostic.endLine - 1, character: diagnostic.endCharacter },
            },
            message: diagnostic.message,
            severity: LSP_SEVERITY[diagnostic.severity],
            source: diagnostic.source,
          })),
          only: [kind],
          triggerKind: 2,
        },
      });

      for (const action of actions ?? []) {
        changed = (await this.applyCodeAction(action)) || changed;
      }
    }

    return changed;
  }

  async definition(filePath: string, line: number, character: number): Promise<Location[]> {
    await this.waitReady();
    const absPath = resolve(filePath);
    await this.ensureOpen(absPath);

    const result: any = await this.connection.sendRequest("textDocument/definition", {
      textDocument: { uri: pathToUri(absPath) },
      position: { line: line - 1, character },
    });
    if (!result) return [];

    const items = Array.isArray(result) ? result : [result];
    return items.map(parseLoc);
  }

  async references(filePath: string, line: number, character: number, includeDeclaration = true): Promise<Location[]> {
    await this.waitReady();
    const absPath = resolve(filePath);
    await this.ensureOpen(absPath);

    const result: any = await this.connection.sendRequest("textDocument/references", {
      textDocument: { uri: pathToUri(absPath) },
      position: { line: line - 1, character },
      context: { includeDeclaration },
    });
    return (result ?? []).map(parseLoc);
  }

  async hover(filePath: string, line: number, character: number): Promise<string | null> {
    await this.waitReady();
    const absPath = resolve(filePath);
    await this.ensureOpen(absPath);

    const result: any = await this.connection.sendRequest("textDocument/hover", {
      textDocument: { uri: pathToUri(absPath) },
      position: { line: line - 1, character },
    });
    if (!result?.contents) return null;

    const contents = result.contents;
    if (typeof contents === "string") return contents;
    if ("value" in contents) return contents.value;
    if (Array.isArray(contents)) {
      return contents.map((item: any) => (typeof item === "string" ? item : item.value)).join("\n\n");
    }
    return null;
  }

  async workspaceSymbol(query: string): Promise<WorkspaceSymbol[]> {
    await this.waitReady();

    try {
      const result: any = await this.connection.sendRequest("workspace/symbol", { query });
      if (!result || !Array.isArray(result)) return [];

      return result.map((symbol: any) => ({
        name: symbol.name,
        kind: SYMBOL_KIND[symbol.kind] ?? `Unknown(${symbol.kind})`,
        file: symbol.location?.uri ? uriToPath(symbol.location.uri) : "",
        line: (symbol.location?.range?.start?.line ?? 0) + 1,
        character: symbol.location?.range?.start?.character ?? 0,
        containerName: symbol.containerName || undefined,
      }));
    } catch {
      return [];
    }
  }

  getDiagnostics(filePath: string): Diagnostic[] {
    return this.diagnostics.get(resolve(filePath)) ?? [];
  }

  getErrorDiagnostics(filePath: string): Diagnostic[] {
    return this.getDiagnostics(filePath).filter((diagnostic) => diagnostic.severity === "error");
  }

  private terminateProcess(): void {
    try { this.connection.end(); } catch {}
    try { this.connection.dispose(); } catch {}
    try { this.process.stdin?.destroy(); } catch {}
    try { this.process.stdout?.destroy(); } catch {}
    try { this.process.stderr?.destroy(); } catch {}
    try { this.process.kill(); } catch {}
  }

  terminate(): void {
    this.dead = true;
    this.ready = false;
    this.terminateProcess();
  }

  async shutdown(): Promise<void> {
    if (this.dead) {
      this.terminateProcess();
      return;
    }

    this.dead = true;
    this.ready = false;
    try {
      await Promise.race([
        this.connection.sendRequest("shutdown").then(() => {
          return this.connection.sendNotification("exit").catch(() => {});
        }),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          timer.unref?.();
        }),
      ]);
    } catch {
      // already dead
    }

    this.terminateProcess();
  }
}
