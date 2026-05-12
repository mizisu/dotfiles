import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type JsonObject = Record<string, unknown>;

export interface LspWorkspaceSettings {
  configuration: JsonObject;
  sources: string[];
  initializationOptionsByServer: Record<string, unknown>;
}

const DEFAULT_CONFIGURATION: JsonObject = {
  // Prefer committed ruff.toml / pyproject.toml over editor-provided Ruff knobs.
  ruff: {
    configurationPreference: "filesystemFirst",
  },
  // Match projects where ESLint CLI needs package/config-relative cwd, especially monorepos.
  eslint: {
    workingDirectories: [{ mode: "auto" }],
  },
};

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  if (isPlainObject(value)) {
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) result[key] = cloneJson(child);
    return result as T;
  }
  return value;
}

function deepMerge(target: JsonObject, source: JsonObject): JsonObject {
  for (const [key, value] of Object.entries(source)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      deepMerge(target[key] as JsonObject, value);
    } else {
      target[key] = cloneJson(value);
    }
  }
  return target;
}

function stripJsonComments(input: string): string {
  let output = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;
    const next = input[index + 1];

    if (lineComment) {
      if (char === "\n" || char === "\r") {
        lineComment = false;
        output += char;
      }
      continue;
    }

    if (blockComment) {
      if (char === "*" && next === "/") {
        blockComment = false;
        index += 1;
      } else if (char === "\n" || char === "\r") {
        output += char;
      }
      continue;
    }

    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (quote) {
      output += char;
      if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      output += char;
      continue;
    }

    if (char === "/" && next === "/") {
      lineComment = true;
      index += 1;
      continue;
    }

    if (char === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function stripTrailingCommas(input: string): string {
  let output = "";
  let quote: "'" | "\"" | undefined;
  let escaped = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }

    if (quote) {
      output += char;
      if (char === "\\") escaped = true;
      else if (char === quote) quote = undefined;
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      output += char;
      continue;
    }

    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(input[lookahead] ?? "")) lookahead += 1;
      if (input[lookahead] === "}" || input[lookahead] === "]") continue;
    }

    output += char;
  }

  return output;
}

function parseJsoncFile(filePath: string): JsonObject | undefined {
  if (!existsSync(filePath)) return undefined;

  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed = JSON.parse(stripTrailingCommas(stripJsonComments(raw)));
    return isPlainObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function setDeep(target: JsonObject, path: string[], value: unknown): void {
  let current = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const part = path[index]!;
    if (!isPlainObject(current[part])) current[part] = {};
    current = current[part] as JsonObject;
  }

  const leaf = path[path.length - 1]!;
  if (isPlainObject(value) && isPlainObject(current[leaf])) deepMerge(current[leaf] as JsonObject, value);
  else current[leaf] = cloneJson(value);
}

function expandDottedKeys(input: JsonObject): JsonObject {
  const output: JsonObject = {};

  for (const [key, value] of Object.entries(input)) {
    const expandedValue = isPlainObject(value) && !(key.startsWith("[") && key.endsWith("]"))
      ? expandDottedKeys(value)
      : cloneJson(value);

    if (key.includes(".") && !(key.startsWith("[") && key.endsWith("]"))) {
      setDeep(output, key.split(".").filter(Boolean), expandedValue);
      continue;
    }

    if (isPlainObject(expandedValue) && isPlainObject(output[key])) deepMerge(output[key] as JsonObject, expandedValue);
    else output[key] = expandedValue;
  }

  return output;
}

function getPath(input: JsonObject, section: string | undefined): unknown {
  if (!section) return input;

  let current: unknown = input;
  for (const part of section.split(".").filter(Boolean)) {
    if (!isPlainObject(current) || !(part in current)) return {};
    current = current[part];
  }
  return current;
}

function collectCandidatePaths(projectRoot: string, workspaceRoot: string): string[] {
  const roots = [...new Set([projectRoot, workspaceRoot])];
  return roots.flatMap((root) => [
    resolve(root, ".vscode/settings.json"),
    resolve(root, ".vscode/settings.jsonc"),
    resolve(root, ".pi/lsp-settings.json"),
  ]);
}

function piProjectSettings(projectRoot: string): { settings?: JsonObject; initializationOptions?: Record<string, unknown>; source?: string } {
  const filePath = resolve(projectRoot, ".pi/settings.json");
  const parsed = parseJsoncFile(filePath);
  if (!parsed) return {};

  const lsp = parsed.lsp;
  if (!isPlainObject(lsp)) return {};

  const settings = isPlainObject(lsp.settings) ? expandDottedKeys(lsp.settings) : undefined;
  const initializationOptions = isPlainObject(lsp.initializationOptions)
    ? cloneJson(lsp.initializationOptions as Record<string, unknown>)
    : undefined;

  return settings || initializationOptions ? { settings, initializationOptions, source: filePath } : {};
}

export function loadLspWorkspaceSettings(projectRoot: string, workspaceRoot: string): LspWorkspaceSettings {
  const configuration = cloneJson(DEFAULT_CONFIGURATION);
  const sources: string[] = [];
  const initializationOptionsByServer: Record<string, unknown> = {};

  for (const filePath of collectCandidatePaths(projectRoot, workspaceRoot)) {
    const parsed = parseJsoncFile(filePath);
    if (!parsed) continue;
    deepMerge(configuration, expandDottedKeys(parsed));
    sources.push(filePath);
  }

  const piSettings = piProjectSettings(projectRoot);
  if (piSettings.settings) deepMerge(configuration, piSettings.settings);
  if (piSettings.initializationOptions) deepMerge(initializationOptionsByServer, piSettings.initializationOptions);
  if (piSettings.source) sources.push(piSettings.source);

  return { configuration, sources, initializationOptionsByServer };
}

export function configurationSection(settings: LspWorkspaceSettings, section?: string): unknown {
  return cloneJson(getPath(settings.configuration, section));
}

export function initializationOptionsForServer(serverId: string, settings: LspWorkspaceSettings): unknown {
  const explicit = settings.initializationOptionsByServer[serverId];
  if (explicit !== undefined) return cloneJson(explicit);

  if (serverId === "ruff") {
    return { settings: configurationSection(settings, "ruff") };
  }

  return undefined;
}
