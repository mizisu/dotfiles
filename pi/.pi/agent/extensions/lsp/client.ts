import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as rpc from "vscode-jsonrpc/node";
import {
  configurationSection,
  initializationOptionsForServer,
  loadLspWorkspaceSettings,
  type LspWorkspaceSettings,
} from "./settings.js";

export type LspClientState = "starting" | "ready" | "failed" | "dead";

export interface LspCommand {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  source: "local" | "global" | "fallback";
}

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

export interface WorkspaceSymbol {
  name: string;
  kind: string;
  file: string;
  line: number;
  character: number;
  containerName?: string;
}

export interface LspLocation {
  file: string;
  line: number;
  character: number;
  endLine: number;
  endCharacter: number;
}

type DiagnosticMode = "document" | "full";

type DiagnosticRequestResult = {
  handled: boolean;
  matched: boolean;
  byFile: Map<string, Diagnostic[]>;
};

type CapabilityRegistration = {
  id: string;
  method: string;
  registerOptions?: {
    identifier?: string;
    workspaceDiagnostics?: boolean;
  };
};

const INITIALIZE_TIMEOUT_MS = 45_000;
const DIAGNOSTICS_DEBOUNCE_MS = 150;
const DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS = 5_000;
const DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS = 10_000;
const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 3_000;
const CODE_ACTION_TIMEOUT_MS = 5_000;
const CODE_ACTION_RESOLVE_TIMEOUT_MS = 3_000;
const EXECUTE_COMMAND_TIMEOUT_MS = 5_000;
const FILE_CHANGE_CREATED = 1;
const FILE_CHANGE_CHANGED = 2;

const SEVERITY: Record<number, Diagnostic["severity"]> = {
  1: "error",
  2: "warning",
  3: "info",
  4: "hint",
};

const SYMBOL_KIND: Record<number, string> = {
  1: "File",
  2: "Module",
  3: "Namespace",
  4: "Package",
  5: "Class",
  6: "Method",
  7: "Property",
  8: "Field",
  9: "Constructor",
  10: "Enum",
  11: "Interface",
  12: "Function",
  13: "Variable",
  14: "Constant",
  15: "String",
  16: "Number",
  17: "Boolean",
  18: "Array",
  19: "Object",
  20: "Key",
  21: "Null",
  22: "EnumMember",
  23: "Struct",
  24: "Event",
  25: "Operator",
  26: "TypeParameter",
};

const CODE_ACTION_KIND_VALUES = [
  "",
  "quickfix",
  "refactor",
  "refactor.extract",
  "refactor.inline",
  "refactor.rewrite",
  "source",
  "source.organizeImports",
  "source.organizeImports.biome",
  "source.fixAll",
  "source.fixAll.biome",
];

function uriToPath(uri: string): string {
  try {
    return fileURLToPath(uri);
  } catch {
    return decodeURIComponent(uri.replace(/^file:\/\//, ""));
  }
}

function parseDiagnostic(filePath: string, diagnostic: any): Diagnostic {
  return {
    file: filePath,
    line: (diagnostic.range?.start?.line ?? 0) + 1,
    character: diagnostic.range?.start?.character ?? 0,
    endLine: (diagnostic.range?.end?.line ?? diagnostic.range?.start?.line ?? 0) + 1,
    endCharacter: diagnostic.range?.end?.character ?? diagnostic.range?.start?.character ?? 0,
    severity: SEVERITY[diagnostic.severity ?? 3] ?? "info",
    message: diagnostic.message ?? "",
    source: diagnostic.source,
  };
}

function parseWorkspaceSymbol(symbol: any): WorkspaceSymbol | undefined {
  const location = symbol.location;
  const uri = location?.uri ?? location?.targetUri;
  const range = location?.range ?? location?.targetSelectionRange ?? location?.targetRange;
  if (!uri || !range?.start) return undefined;

  return {
    name: symbol.name ?? "<unknown>",
    kind: SYMBOL_KIND[symbol.kind] ?? `Unknown(${symbol.kind})`,
    file: uriToPath(uri),
    line: (range.start.line ?? 0) + 1,
    character: range.start.character ?? 0,
    containerName: symbol.containerName || undefined,
  };
}

function parseLocation(location: any): LspLocation | undefined {
  const uri = location?.uri ?? location?.targetUri;
  const range = location?.range ?? location?.targetSelectionRange ?? location?.targetRange;
  if (!uri || !range?.start) return undefined;

  return {
    file: uriToPath(uri),
    line: (range.start.line ?? 0) + 1,
    character: range.start.character ?? 0,
    endLine: (range.end?.line ?? range.start.line ?? 0) + 1,
    endCharacter: range.end?.character ?? range.start.character ?? 0,
  };
}

function parseLocations(result: any): LspLocation[] {
  const rawLocations = Array.isArray(result) ? result : result ? [result] : [];
  return dedupeLocations(rawLocations.map(parseLocation).filter((location): location is LspLocation => Boolean(location)));
}

function dedupeLocations(items: LspLocation[]): LspLocation[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.file}:${item.line}:${item.character}:${item.endLine}:${item.endCharacter}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeDiagnostics(items: Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = JSON.stringify({
      file: item.file,
      line: item.line,
      character: item.character,
      endLine: item.endLine,
      endCharacter: item.endCharacter,
      severity: item.severity,
      source: item.source,
      message: item.message,
    });
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function positionToOffset(text: string, line: number, character: number): number {
  let offset = 0;
  for (let currentLine = 0; currentLine < line; currentLine++) {
    const next = text.indexOf("\n", offset);
    if (next === -1) return text.length;
    offset = next + 1;
  }
  return Math.min(offset + character, text.length);
}

function applyTextEdits(text: string, edits: any[]): string {
  const sorted = [...edits].sort((a, b) => {
    const aStart = positionToOffset(text, a.range.start.line, a.range.start.character);
    const bStart = positionToOffset(text, b.range.start.line, b.range.start.character);
    return bStart - aStart;
  });

  let nextText = text;
  for (const edit of sorted) {
    const start = positionToOffset(text, edit.range.start.line, edit.range.start.character);
    const end = positionToOffset(text, edit.range.end.line, edit.range.end.character);
    nextText = `${nextText.slice(0, start)}${edit.newText ?? ""}${nextText.slice(end)}`;
  }
  return nextText;
}

function validTextEdits(edits: any): any[] {
  return Array.isArray(edits)
    ? edits.filter((edit) => edit?.range?.start && edit?.range?.end)
    : [];
}

function workspaceEditEntries(edit: any): Array<{ filePath: string; edits: any[] }> {
  const byFile = new Map<string, any[]>();
  const add = (uri: unknown, edits: any) => {
    if (typeof uri !== "string") return;
    const valid = validTextEdits(edits);
    if (valid.length === 0) return;
    const filePath = uriToPath(uri);
    byFile.set(filePath, [...(byFile.get(filePath) ?? []), ...valid]);
  };

  if (edit?.changes && typeof edit.changes === "object") {
    for (const [uri, edits] of Object.entries(edit.changes)) add(uri, edits);
  }

  if (Array.isArray(edit?.documentChanges)) {
    for (const change of edit.documentChanges) {
      add(change?.textDocument?.uri, change?.edits);
    }
  }

  return [...byFile.entries()].map(([filePath, edits]) => ({ filePath, edits }));
}

function hasWorkspaceEdit(value: any): boolean {
  return Boolean(value && typeof value === "object" && (value.changes || value.documentChanges));
}

function codeActionKindMatches(actionKind: unknown, requestedKind: string): boolean {
  if (typeof actionKind !== "string" || !actionKind) return true;
  return actionKind === requestedKind
    || actionKind.startsWith(`${requestedKind}.`)
    || requestedKind.startsWith(`${actionKind}.`);
}

function lspCommandParams(command: any): { command: string; arguments?: any[] } | undefined {
  if (typeof command === "string") return { command };
  if (!command || typeof command.command !== "string") return undefined;

  const params: { command: string; arguments?: any[] } = { command: command.command };
  if (Array.isArray(command.arguments)) params.arguments = command.arguments;
  return params;
}

function codeActionTitle(action: any, fallback: string): string {
  if (typeof action?.title === "string" && action.title) return action.title;
  if (typeof action?.command?.title === "string" && action.command.title) return action.command.title;
  return fallback;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export class LspClient {
  private process: ChildProcess | undefined;
  private connection: rpc.MessageConnection | undefined;
  private readyPromise: Promise<void> | undefined;
  private stderrTail = "";
  private state: LspClientState = "starting";
  private error: string | undefined;
  private serverCapabilities: any = {};
  private pushDiagnostics = new Map<string, Diagnostic[]>();
  private pullDiagnostics = new Map<string, Diagnostic[]>();
  private published = new Map<string, { at: number; version?: number }>();
  private diagnosticRegistrations = new Map<string, CapabilityRegistration>();
  private diagnosticsListeners = new Set<(filePath: string) => void>();
  private registrationListeners = new Set<() => void>();
  private openFiles = new Set<string>();
  private fileVersions = new Map<string, number>();
  private fileTexts = new Map<string, string>();
  private workspaceEditGeneration = 0;
  private readonly workspaceSettings: LspWorkspaceSettings;

  constructor(
    public readonly id: string,
    public readonly displayName: string,
    private readonly lspCommand: LspCommand,
    projectRoot: string,
    private readonly workspaceRoot: string,
    private readonly onStateChange: () => void,
  ) {
    this.workspaceSettings = loadLspWorkspaceSettings(projectRoot, workspaceRoot);
  }

  start(): void {
    if (this.process) return;

    try {
      this.process = spawn(this.lspCommand.command, this.lspCommand.args, {
        cwd: this.lspCommand.cwd,
        env: { ...process.env, ...(this.lspCommand.env ?? {}) },
        stdio: "pipe",
      });
    } catch (error) {
      this.fail(error);
      return;
    }

    this.process.on("error", (error) => this.fail(error));
    this.process.on("exit", () => {
      if (this.state !== "failed") this.state = "dead";
      this.onStateChange();
      try { this.connection?.dispose(); } catch {}
    });

    this.process.stderr?.on("data", (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString("utf8")}`.slice(-4000);
    });

    this.connection = rpc.createMessageConnection(
      new rpc.StreamMessageReader(this.process.stdout!),
      new rpc.StreamMessageWriter(this.process.stdin!),
    );

    this.connection.onNotification("textDocument/publishDiagnostics", (params: any) => {
      const filePath = uriToPath(params.uri);
      const diagnostics = (params.diagnostics ?? []).map((diagnostic: any) => parseDiagnostic(filePath, diagnostic));
      this.published.set(filePath, {
        at: Date.now(),
        version: typeof params.version === "number" ? params.version : undefined,
      });
      this.pushDiagnostics.set(filePath, diagnostics);
      this.emitDiagnostics(filePath);
    });

    this.connection.onRequest("workspace/configuration", (params: any) => {
      const items = Array.isArray(params?.items) ? params.items : [];
      return items.map((item: any) => configurationSection(
        this.workspaceSettings,
        typeof item?.section === "string" ? item.section : undefined,
      ));
    });

    this.connection.onRequest("workspace/applyEdit", async (params: any) => {
      try {
        await this.applyWorkspaceEdit(params?.edit);
        return { applied: true };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { applied: false, failureReason: message };
      }
    });

    this.connection.onRequest("client/registerCapability", (params: any) => {
      let changed = false;
      for (const registration of params.registrations ?? []) {
        if (registration.method !== "textDocument/diagnostic") continue;
        this.diagnosticRegistrations.set(registration.id, registration);
        changed = true;
      }
      if (changed) this.emitRegistrationChange();
      return null;
    });

    this.connection.onRequest("client/unregisterCapability", (params: any) => {
      let changed = false;
      for (const registration of params.unregisterations ?? params.registrations ?? []) {
        if (registration.method !== "textDocument/diagnostic") continue;
        this.diagnosticRegistrations.delete(registration.id);
        changed = true;
      }
      if (changed) this.emitRegistrationChange();
      return null;
    });

    this.connection.onRequest("workspace/workspaceFolders", () => [
      { uri: pathToUri(this.workspaceRoot), name: this.displayName },
    ]);

    this.connection.onRequest("workspace/diagnostic/refresh", () => null);

    this.connection.onError((error) => {
      if (this.state === "starting" || this.state === "ready") {
        this.error = String(error?.[0] ?? error);
      }
    });

    this.connection.onClose(() => {
      if (this.state !== "failed") this.state = "dead";
      this.onStateChange();
    });

    this.connection.listen();
    this.readyPromise = this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      const initializationOptions = initializationOptionsForServer(this.id, this.workspaceSettings);
      const result: any = await withTimeout(
        this.connection!.sendRequest("initialize", {
          processId: process.pid,
          rootUri: pathToUri(this.workspaceRoot),
          workspaceFolders: [{ uri: pathToUri(this.workspaceRoot), name: this.displayName }],
          ...(initializationOptions !== undefined ? { initializationOptions } : {}),
          capabilities: {
            window: { workDoneProgress: true },
            textDocument: {
              synchronization: { dynamicRegistration: false, didOpen: true, didChange: true, didSave: true },
              publishDiagnostics: { relatedInformation: true, versionSupport: true },
              diagnostic: { dynamicRegistration: true, relatedDocumentSupport: true },
              formatting: { dynamicRegistration: false },
              codeAction: {
                dynamicRegistration: false,
                dataSupport: true,
                resolveSupport: { properties: ["edit", "command"] },
                codeActionLiteralSupport: { codeActionKind: { valueSet: CODE_ACTION_KIND_VALUES } },
              },
              definition: { dynamicRegistration: false, linkSupport: true },
              references: { dynamicRegistration: false },
            },
            workspace: {
              workspaceFolders: true,
              configuration: true,
              didChangeConfiguration: { dynamicRegistration: false },
              applyEdit: true,
              workspaceEdit: { documentChanges: true },
              executeCommand: { dynamicRegistration: false },
              symbol: { dynamicRegistration: false },
              diagnostics: { refreshSupport: false },
              didChangeWatchedFiles: { dynamicRegistration: true, relativePatternSupport: false },
            },
          },
        }),
        INITIALIZE_TIMEOUT_MS,
        `${this.displayName} initialize timed out`,
      );

      this.serverCapabilities = result?.capabilities ?? {};
      await this.connection!.sendNotification("initialized", {}).catch(() => {});
      if (this.state !== "dead") this.state = "ready";
      this.onStateChange();
    } catch (error) {
      this.fail(error);
    }
  }

  waitReady(): Promise<void> | undefined {
    return this.readyPromise;
  }

  getState(): LspClientState {
    return this.state;
  }

  getError(): string | undefined {
    return this.error;
  }

  getStderrTail(): string {
    return this.stderrTail.trim();
  }

  getCommand(): LspCommand {
    return this.lspCommand;
  }

  supportsFormatting(): boolean {
    return Boolean(this.serverCapabilities?.documentFormattingProvider);
  }

  supportsCodeActions(): boolean {
    return Boolean(this.serverCapabilities?.codeActionProvider);
  }

  private usesIncrementalSync(): boolean {
    const sync = this.serverCapabilities?.textDocumentSync;
    const change = typeof sync === "number" ? sync : sync?.change;
    return change === 2;
  }

  supportsPullDiagnostics(): boolean {
    return Boolean(this.serverCapabilities?.diagnosticProvider) || this.diagnosticRegistrations.size > 0;
  }

  async ensureOpen(filePath: string): Promise<number> {
    await this.ensureReady();

    const absPath = resolve(filePath);
    const version = this.fileVersions.get(absPath);
    if (this.openFiles.has(absPath) && version !== undefined) return version;

    const text = await readFile(absPath, "utf8");
    this.fileVersions.set(absPath, 0);
    this.fileTexts.set(absPath, text);
    this.pushDiagnostics.delete(absPath);
    this.pullDiagnostics.delete(absPath);

    await this.notifyWatchedFile(absPath, FILE_CHANGE_CREATED);
    await this.connection!.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri: pathToUri(absPath),
        languageId: this.languageId(absPath),
        version: 0,
        text,
      },
    }).catch(() => {});
    this.openFiles.add(absPath);
    return 0;
  }

  async notifyChanged(filePath: string): Promise<number> {
    await this.ensureReady();

    const absPath = resolve(filePath);
    if (!this.openFiles.has(absPath)) {
      const version = await this.ensureOpen(absPath);
      await this.connection!.sendNotification("textDocument/didSave", {
        textDocument: { uri: pathToUri(absPath) },
      }).catch(() => {});
      return version;
    }

    const previousText = this.fileTexts.get(absPath) ?? "";
    const text = await readFile(absPath, "utf8");
    const version = (this.fileVersions.get(absPath) ?? 0) + 1;
    this.fileVersions.set(absPath, version);
    this.fileTexts.set(absPath, text);

    await this.notifyWatchedFile(absPath, FILE_CHANGE_CHANGED);
    await this.connection!.sendNotification("textDocument/didChange", {
      textDocument: { uri: pathToUri(absPath), version },
      contentChanges: this.usesIncrementalSync()
        ? [{ range: fullDocumentRange(previousText), text }]
        : [{ text }],
    }).catch(() => {});

    await this.connection!.sendNotification("textDocument/didSave", {
      textDocument: { uri: pathToUri(absPath) },
    }).catch(() => {});

    return version;
  }

  async collectDiagnostics(filePath: string, mode: DiagnosticMode = "document"): Promise<Diagnostic[]> {
    const absPath = resolve(filePath);
    if (mode === "full") this.pullDiagnostics.clear();

    const after = Date.now();
    const version = await this.notifyChanged(absPath);
    await this.waitForDiagnostics({ path: absPath, version, mode, after });
    return mode === "full" ? this.getAllDiagnostics() : this.getDiagnostics(absPath);
  }

  async waitForDiagnostics(request: { path: string; version: number; mode?: DiagnosticMode; after?: number }): Promise<void> {
    await this.ensureReady();

    const absPath = resolve(request.path);
    const mode = request.mode ?? "document";
    const startedAt = request.after ?? Date.now();
    const timeout = mode === "full" ? DIAGNOSTICS_FULL_WAIT_TIMEOUT_MS : DIAGNOSTICS_DOCUMENT_WAIT_TIMEOUT_MS;

    while (Date.now() - startedAt < timeout) {
      const result = mode === "full"
        ? await this.requestFullDiagnostics(absPath)
        : await this.requestDocumentDiagnostics(absPath);
      if (result.matched || (mode === "full" && result.handled)) return;

      const remaining = timeout - (Date.now() - startedAt);
      if (remaining <= 0) return;

      const event = await Promise.race([
        this.waitForFreshPush({
          path: mode === "full" ? undefined : absPath,
          version: mode === "full" ? undefined : request.version,
          after: startedAt,
          timeout: remaining,
        }).then((hit) => hit ? "push" : "timeout"),
        this.waitForRegistrationChange(remaining).then((hit) => hit ? "registration" : "timeout"),
        delay(Math.min(250, remaining)).then(() => "tick"),
      ]);

      if (event === "push") return;
    }
  }

  async formatDocument(filePath: string): Promise<boolean> {
    await this.ensureReady();
    if (!this.supportsFormatting()) return false;

    const absPath = resolve(filePath);
    await this.ensureOpen(absPath);

    const edits: any = await this.connection!.sendRequest("textDocument/formatting", {
      textDocument: { uri: pathToUri(absPath) },
      options: {
        tabSize: 2,
        insertSpaces: true,
        trimTrailingWhitespace: true,
        insertFinalNewline: true,
        trimFinalNewlines: true,
      },
    });

    if (!Array.isArray(edits) || edits.length === 0) return false;

    const original = await readFile(absPath, "utf8");
    const updated = applyTextEdits(original, edits);
    if (updated === original) return false;

    await writeFile(absPath, updated, "utf8");
    await this.notifyChanged(absPath);
    return true;
  }

  async runCodeActions(filePath: string, onlyKinds: readonly string[]): Promise<string[]> {
    await this.ensureReady();
    if (!this.supportsCodeActions()) return [];

    const absPath = resolve(filePath);
    const applied: string[] = [];

    for (const onlyKind of onlyKinds) {
      await this.notifyChanged(absPath);
      const actions = await this.requestCodeActions(absPath, onlyKind);
      const candidates = actions.filter((action) => action && !action.disabled && codeActionKindMatches(action.kind, onlyKind));

      for (const action of candidates) {
        if (await this.applyCodeAction(action)) {
          applied.push(codeActionTitle(action, onlyKind));
          break;
        }
      }
    }

    return applied;
  }

  getDiagnostics(filePath: string): Diagnostic[] {
    const absPath = resolve(filePath);
    return dedupeDiagnostics([...(this.pushDiagnostics.get(absPath) ?? []), ...(this.pullDiagnostics.get(absPath) ?? [])]);
  }

  getAllDiagnostics(): Diagnostic[] {
    return dedupeDiagnostics([
      ...[...this.pushDiagnostics.values()].flat(),
      ...[...this.pullDiagnostics.values()].flat(),
    ]);
  }

  async workspaceSymbol(query: string): Promise<WorkspaceSymbol[]> {
    await this.ensureReady();

    const result: any = await withTimeout(
      this.connection!.sendRequest("workspace/symbol", { query }),
      5_000,
      `${this.displayName} workspace/symbol timed out`,
    ).catch(() => []);
    if (!Array.isArray(result)) return [];

    return result.map(parseWorkspaceSymbol).filter((symbol): symbol is WorkspaceSymbol => Boolean(symbol));
  }

  async gotoDefinition(filePath: string, line: number, character: number): Promise<LspLocation[]> {
    const absPath = resolve(filePath);
    await this.notifyChanged(absPath);

    const result: any = await withTimeout(
      this.connection!.sendRequest("textDocument/definition", {
        textDocument: { uri: pathToUri(absPath) },
        position: { line: Math.max(0, line - 1), character: Math.max(0, character) },
      }),
      5_000,
      `${this.displayName} textDocument/definition timed out`,
    ).catch(() => null);

    return parseLocations(result);
  }

  async findReferences(filePath: string, line: number, character: number, includeDeclaration = true): Promise<LspLocation[]> {
    const absPath = resolve(filePath);
    await this.notifyChanged(absPath);

    const result: any = await withTimeout(
      this.connection!.sendRequest("textDocument/references", {
        textDocument: { uri: pathToUri(absPath) },
        position: { line: Math.max(0, line - 1), character: Math.max(0, character) },
        context: { includeDeclaration },
      }),
      5_000,
      `${this.displayName} textDocument/references timed out`,
    ).catch(() => null);

    return parseLocations(result);
  }

  private async requestCodeActions(filePath: string, onlyKind: string): Promise<any[]> {
    const text = this.fileTexts.get(filePath) ?? await readFile(filePath, "utf8");
    const result: any = await withTimeout(
      this.connection!.sendRequest("textDocument/codeAction", {
        textDocument: { uri: pathToUri(filePath) },
        range: fullDocumentRange(text),
        context: {
          diagnostics: [],
          only: [onlyKind],
          triggerKind: 1,
        },
      }),
      CODE_ACTION_TIMEOUT_MS,
      `${this.displayName} textDocument/codeAction timed out`,
    ).catch(() => []);

    return Array.isArray(result) ? result : [];
  }

  private async resolveCodeAction(action: any): Promise<any> {
    const provider = this.serverCapabilities?.codeActionProvider;
    const isCommandOnly = typeof action?.command === "string" && !action.kind && !action.data && !action.edit;
    if (isCommandOnly || action?.edit || !(provider && typeof provider === "object" && provider.resolveProvider)) return action;

    return withTimeout(
      this.connection!.sendRequest("codeAction/resolve", action),
      CODE_ACTION_RESOLVE_TIMEOUT_MS,
      `${this.displayName} codeAction/resolve timed out`,
    ).catch(() => action);
  }

  private async applyCodeAction(action: any): Promise<boolean> {
    const resolved = await this.resolveCodeAction(action);
    let changed = false;

    if (hasWorkspaceEdit(resolved?.edit)) {
      changed = await this.applyWorkspaceEdit(resolved.edit) || changed;
    }

    const command = typeof resolved?.command === "string" ? resolved : resolved?.command;
    const params = lspCommandParams(command);
    if (params) {
      const before = this.workspaceEditGeneration;
      const result: any = await withTimeout(
        this.connection!.sendRequest("workspace/executeCommand", params),
        EXECUTE_COMMAND_TIMEOUT_MS,
        `${this.displayName} workspace/executeCommand timed out`,
      ).catch(() => undefined);

      if (hasWorkspaceEdit(result)) changed = await this.applyWorkspaceEdit(result) || changed;
      if (this.workspaceEditGeneration > before) changed = true;
    }

    return changed;
  }

  private async applyWorkspaceEdit(edit: any): Promise<boolean> {
    const entries = workspaceEditEntries(edit);
    let changed = false;

    for (const { filePath, edits } of entries) {
      const original = await readFile(filePath, "utf8");
      const updated = applyTextEdits(original, edits);
      if (updated === original) continue;

      await writeFile(filePath, updated, "utf8");
      changed = true;
      await this.notifyChanged(filePath).catch(() => {});
    }

    if (changed) this.workspaceEditGeneration += 1;
    return changed;
  }

  private async requestDocumentDiagnostics(filePath: string): Promise<{ handled: boolean; matched: boolean }> {
    const identifiers = this.documentDiagnosticIdentifiers();
    const supportsDocumentPull = this.serverCapabilities?.diagnosticProvider || this.hasDocumentDiagnosticRegistration();
    if (!supportsDocumentPull) return { handled: false, matched: false };

    return this.mergeDiagnosticResults(filePath, await Promise.all([
      this.requestDiagnosticReport(filePath),
      ...identifiers.map((identifier) => this.requestDiagnosticReport(filePath, identifier)),
    ]));
  }

  private async requestFullDiagnostics(filePath: string): Promise<{ handled: boolean; matched: boolean }> {
    const documentIdentifiers = this.documentDiagnosticIdentifiers();
    const workspaceCapabilityIdentifier = this.workspaceDiagnosticCapabilityIdentifier();
    const workspaceIdentifiers = this.workspaceDiagnosticIdentifiers()
      .filter((identifier) => identifier !== workspaceCapabilityIdentifier);
    const requests = [
      ...(this.serverCapabilities?.diagnosticProvider || this.hasDocumentDiagnosticRegistration()
        ? [this.requestDiagnosticReport(filePath)]
        : []),
      ...documentIdentifiers.map((identifier) => this.requestDiagnosticReport(filePath, identifier)),
      ...(this.hasWorkspaceDiagnosticCapability()
        ? [this.requestWorkspaceDiagnosticReport(workspaceCapabilityIdentifier)]
        : []),
      ...workspaceIdentifiers.map((identifier) => this.requestWorkspaceDiagnosticReport(identifier)),
    ];

    if (requests.length === 0) return { handled: false, matched: false };
    return this.mergeDiagnosticResults(filePath, await Promise.all(requests));
  }

  private async requestDiagnosticReport(filePath: string, identifier?: string): Promise<DiagnosticRequestResult> {
    const report: any = await withTimeout(
      this.connection!.sendRequest("textDocument/diagnostic", {
        ...(identifier ? { identifier } : {}),
        textDocument: { uri: pathToUri(filePath) },
      }),
      DIAGNOSTICS_REQUEST_TIMEOUT_MS,
      `${this.displayName} textDocument/diagnostic timed out`,
    ).catch(() => null);

    if (!report) return { handled: false, matched: false, byFile: new Map() };

    const byFile = new Map<string, Diagnostic[]>();
    const add = (target: string, diagnostics: any[]) => {
      byFile.set(target, [...(byFile.get(target) ?? []), ...diagnostics.map((diagnostic) => parseDiagnostic(target, diagnostic))]);
    };

    let handled = false;
    let matched = false;
    if (report.kind === "unchanged") {
      handled = true;
      matched = true;
    }
    if (Array.isArray(report.items)) {
      add(filePath, report.items);
      handled = true;
      matched = true;
    }

    for (const [uri, related] of Object.entries(report.relatedDocuments ?? {})) {
      const relatedPath = uriToPath(uri);
      const items = (related as any)?.items;
      if (!Array.isArray(items)) continue;
      add(relatedPath, items);
      handled = true;
      matched = matched || relatedPath === filePath;
    }

    return { handled, matched, byFile };
  }

  private async requestWorkspaceDiagnosticReport(identifier?: string): Promise<DiagnosticRequestResult> {
    const report: any = await withTimeout(
      this.connection!.sendRequest("workspace/diagnostic", {
        ...(identifier ? { identifier } : {}),
        previousResultIds: [],
      }),
      DIAGNOSTICS_REQUEST_TIMEOUT_MS,
      `${this.displayName} workspace/diagnostic timed out`,
    ).catch(() => null);

    if (!report) return { handled: false, matched: false, byFile: new Map() };

    const byFile = new Map<string, Diagnostic[]>();
    for (const item of report.items ?? []) {
      const filePath = item.uri ? uriToPath(item.uri) : undefined;
      if (!filePath || item.kind === "unchanged" || !Array.isArray(item.items)) continue;
      byFile.set(filePath, [...(byFile.get(filePath) ?? []), ...item.items.map((diagnostic: any) => parseDiagnostic(filePath, diagnostic))]);
    }

    return { handled: true, matched: false, byFile };
  }

  private mergeDiagnosticResults(filePath: string, results: DiagnosticRequestResult[]): { handled: boolean; matched: boolean } {
    const handled = results.some((result) => result.handled);
    const matched = results.some((result) => result.matched);
    if (!handled) return { handled: false, matched: false };

    const merged = new Map<string, Diagnostic[]>();
    for (const result of results) {
      for (const [target, diagnostics] of result.byFile.entries()) {
        merged.set(target, [...(merged.get(target) ?? []), ...diagnostics]);
      }
    }

    if (matched && !merged.has(filePath)) merged.set(filePath, []);
    for (const [target, diagnostics] of merged.entries()) {
      this.pullDiagnostics.set(target, dedupeDiagnostics(diagnostics));
    }

    return { handled, matched };
  }

  private hasDocumentDiagnosticRegistration(): boolean {
    return [...this.diagnosticRegistrations.values()]
      .some((registration) => registration.registerOptions?.workspaceDiagnostics !== true);
  }

  private hasWorkspaceDiagnosticCapability(): boolean {
    const provider = this.serverCapabilities?.diagnosticProvider;
    return Boolean(provider && typeof provider === "object" && provider.workspaceDiagnostics);
  }

  private workspaceDiagnosticCapabilityIdentifier(): string | undefined {
    const provider = this.serverCapabilities?.diagnosticProvider;
    return provider && typeof provider === "object" && typeof provider.identifier === "string"
      ? provider.identifier
      : undefined;
  }

  private documentDiagnosticIdentifiers(): string[] {
    return [
      ...new Set(
        [...this.diagnosticRegistrations.values()]
          .filter((registration) => registration.registerOptions?.workspaceDiagnostics !== true)
          .map((registration) => registration.registerOptions?.identifier)
          .filter((identifier): identifier is string => Boolean(identifier)),
      ),
    ];
  }

  private workspaceDiagnosticIdentifiers(): string[] {
    return [
      ...new Set(
        [...this.diagnosticRegistrations.values()]
          .filter((registration) => registration.registerOptions?.workspaceDiagnostics === true)
          .map((registration) => registration.registerOptions?.identifier)
          .filter((identifier): identifier is string => Boolean(identifier)),
      ),
    ];
  }

  private waitForFreshPush(request: { path?: string; version?: number; after: number; timeout: number }): Promise<boolean> {
    if (request.timeout <= 0) return Promise.resolve(false);

    return new Promise((resolve) => {
      let done = false;
      let debounceTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        if (debounceTimer) clearTimeout(debounceTimer);
        clearTimeout(timeoutTimer);
        this.diagnosticsListeners.delete(listener);
        resolve(value);
      };

      const check = (filePath: string) => {
        const hit = this.published.get(filePath);
        if (!hit) return;
        if (request.path && typeof hit.version === "number" && hit.version !== request.version) return;
        if (hit.at < request.after && (!request.path || hit.version !== request.version)) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => finish(true), Math.max(0, DIAGNOSTICS_DEBOUNCE_MS - (Date.now() - hit.at)));
        debounceTimer.unref?.();
      };

      const listener = (filePath: string) => {
        if (!request.path || filePath === request.path) check(filePath);
      };
      const timeoutTimer = setTimeout(() => finish(false), request.timeout);
      timeoutTimer.unref?.();
      this.diagnosticsListeners.add(listener);
      if (request.path) check(request.path);
      else for (const filePath of this.published.keys()) check(filePath);
    });
  }

  private waitForRegistrationChange(timeout: number): Promise<boolean> {
    if (timeout <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.registrationListeners.delete(listener);
        resolve(value);
      };
      const listener = () => finish(true);
      const timer = setTimeout(() => finish(false), timeout);
      timer.unref?.();
      this.registrationListeners.add(listener);
    });
  }

  private async notifyWatchedFile(filePath: string, type: number): Promise<void> {
    await this.connection!.sendNotification("workspace/didChangeWatchedFiles", {
      changes: [{ uri: pathToUri(filePath), type }],
    }).catch(() => {});
  }

  private emitDiagnostics(filePath: string): void {
    for (const listener of [...this.diagnosticsListeners]) listener(filePath);
  }

  private emitRegistrationChange(): void {
    for (const listener of [...this.registrationListeners]) listener();
  }

  private async ensureReady(): Promise<void> {
    await this.readyPromise;
    if (this.state !== "ready" || !this.connection) {
      throw new Error(`${this.displayName} is not ready`);
    }
  }

  private languageId(filePath: string): string {
    const ext = extname(filePath).toLowerCase();
    if (ext === ".py" || ext === ".pyi") return "python";
    if (ext === ".tsx") return "typescriptreact";
    if (ext === ".ts") return "typescript";
    if (ext === ".jsx") return "javascriptreact";
    if (ext === ".js") return "javascript";
    if (ext === ".css") return "css";
    if (ext === ".scss") return "scss";
    if (ext === ".sass") return "sass";
    if (ext === ".less") return "less";
    if (ext === ".html") return "html";
    if (ext === ".vue") return "vue";
    if (ext === ".svelte") return "svelte";
    if (ext === ".json") return "json";
    return "plaintext";
  }

  private fail(error: unknown): void {
    this.state = "failed";
    this.error = error instanceof Error ? error.message : String(error);
    this.onStateChange();
    this.kill();
  }

  kill(): void {
    this.state = this.state === "failed" ? "failed" : "dead";
    this.openFiles.clear();
    this.fileVersions.clear();
    this.fileTexts.clear();
    this.pushDiagnostics.clear();
    this.pullDiagnostics.clear();
    this.published.clear();
    this.diagnosticRegistrations.clear();
    this.diagnosticsListeners.clear();
    this.registrationListeners.clear();
    try { this.connection?.end(); } catch {}
    try { this.connection?.dispose(); } catch {}
    try { this.process?.stdin?.destroy(); } catch {}
    try { this.process?.stdout?.destroy(); } catch {}
    try { this.process?.stderr?.destroy(); } catch {}
    try { this.process?.kill(); } catch {}
    this.onStateChange();
  }
}

function fullDocumentRange(text: string): { start: { line: number; character: number }; end: { line: number; character: number } } {
  const lines = text.split(/\r\n|\r|\n/);
  const lastLine = Math.max(0, lines.length - 1);
  return {
    start: { line: 0, character: 0 },
    end: { line: lastLine, character: lines[lastLine]?.length ?? 0 },
  };
}

function pathToUri(filePath: string): string {
  return pathToFileURL(filePath).toString();
}
