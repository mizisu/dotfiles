import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname, relative } from "node:path";
import { spawnSync } from "node:child_process";
import type { LspCommand } from "./client.js";

export type LspRole = "diagnostics" | "format" | "lint" | "symbols" | "navigation" | "tailwind";

export interface ServerSpec {
  id: string;
  displayName: string;
  group: "Python" | "Frontend";
  language: "python" | "typescript" | "css";
  roles: LspRole[];
  extensions: string[];
  workspaceRoot: string;
  command?: LspCommand;
  skipReason?: string;
}

interface ProjectInfo {
  projectRoot: string;
  frontendRoot: string;
  frontendRoots: string[];
  python: boolean;
  frontend: boolean;
  eslint: boolean;
  biome: boolean;
  tailwind: boolean;
}

const PYTHON_EXTENSIONS = [".py", ".pyi"];
const FRONTEND_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"];
const STYLE_EXTENSIONS = [".css", ".scss", ".sass", ".less"];
const TAILWIND_EXTENSIONS = [...FRONTEND_EXTENSIONS, ...STYLE_EXTENSIONS, ".html", ".vue", ".svelte"];

const ESLINT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.mjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
];

const TAILWIND_CONFIGS = [
  "tailwind.config.js",
  "tailwind.config.cjs",
  "tailwind.config.mjs",
  "tailwind.config.ts",
];

function hasAny(root: string, names: string[]): boolean {
  return names.some((name) => existsSync(resolve(root, name)));
}

function commandPath(name: string): string | undefined {
  const result = spawnSync("sh", ["-lc", `command -v ${JSON.stringify(name)}`], {
    encoding: "utf8",
    timeout: 3000,
  });
  const output = result.stdout?.trim();
  return result.status === 0 && output ? output : undefined;
}

function localBin(roots: string[], name: string): string | undefined {
  for (const root of roots) {
    const candidate = resolve(root, "node_modules/.bin", name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function venvBin(root: string, name: string): string | undefined {
  const candidate = resolve(root, ".venv/bin", name);
  return existsSync(candidate) ? candidate : undefined;
}

function firstCommand(candidates: Array<LspCommand | undefined>): LspCommand | undefined {
  return candidates.find(Boolean);
}

function packageJsonHas(root: string, pattern: RegExp): boolean {
  const packageJson = resolve(root, "package.json");
  if (!existsSync(packageJson)) return false;

  try {
    const json = JSON.parse(readFileSync(packageJson, "utf8"));
    const deps = {
      ...(json.dependencies ?? {}),
      ...(json.devDependencies ?? {}),
      ...(json.peerDependencies ?? {}),
    };
    return Object.keys(deps).some((name) => pattern.test(name));
  } catch {
    return false;
  }
}

function gitHasTrackedPython(root: string): boolean {
  const result = spawnSync("git", ["ls-files", "*.py", "*.pyi"], {
    cwd: root,
    encoding: "utf8",
    timeout: 3000,
  });
  return result.status === 0 && result.stdout.trim().length > 0;
}

function projectInfo(projectRoot: string): ProjectInfo {
  const appRoot = resolve(projectRoot, "app");
  const tsConfig = [resolve(appRoot, "tsconfig.json"), resolve(projectRoot, "tsconfig.json")]
    .find((filePath) => existsSync(filePath));
  const frontendRoot = tsConfig
    ? dirname(tsConfig)
    : existsSync(resolve(appRoot, "package.json"))
      ? appRoot
      : projectRoot;
  const frontendRoots = [...new Set([frontendRoot, projectRoot])];

  const python = hasAny(projectRoot, ["pyproject.toml", "manage.py", "requirements.txt"]) || gitHasTrackedPython(projectRoot);
  const frontend = frontendRoots.some((root) => hasAny(root, ["package.json", "tsconfig.json", "jsconfig.json"]));
  const eslint = frontendRoots.some((root) => hasAny(root, ESLINT_CONFIGS));
  const biome = frontendRoots.some((root) => hasAny(root, ["biome.json", "biome.jsonc"]));
  const tailwind = frontendRoots.some((root) => hasAny(root, TAILWIND_CONFIGS) || packageJsonHas(root, /^(tailwindcss|@tailwindcss\/.+)$/));

  return { projectRoot, frontendRoot, frontendRoots, python, frontend, eslint, biome, tailwind };
}

function pyCommand(root: string, binary: string, args: string[], fallbackArgs: string[]): LspCommand | undefined {
  const local = venvBin(root, binary);
  if (local) return { command: local, args, cwd: root, source: "local" };

  const global = commandPath(binary);
  if (global) return { command: global, args, cwd: root, source: "global" };

  const uvx = commandPath("uvx");
  if (uvx) return { command: uvx, args: fallbackArgs, cwd: root, source: "fallback" };

  return undefined;
}

function jsCommand(roots: string[], cwd: string, binary: string, args: string[], fallback: { runner: "npx" | "npm"; args: string[] }): LspCommand | undefined {
  const local = localBin(roots, binary);
  if (local) return { command: local, args, cwd, source: "local" };

  const global = commandPath(binary);
  if (global) return { command: global, args, cwd, source: "global" };

  const runner = commandPath(fallback.runner);
  if (runner) return { command: runner, args: fallback.args, cwd, source: "fallback" };

  return undefined;
}

function skipped(base: Omit<ServerSpec, "command" | "skipReason">, reason: string): ServerSpec {
  return { ...base, skipReason: reason };
}

function runnable(base: Omit<ServerSpec, "command" | "skipReason">, command: LspCommand | undefined, missingReason: string): ServerSpec {
  return command ? { ...base, command } : skipped(base, missingReason);
}

export function detectServers(projectRoot: string): ServerSpec[] {
  const info = projectInfo(projectRoot);
  const specs: ServerSpec[] = [];

  const basedpyrightBase = {
    id: "basedpyright",
    displayName: "basedpyright",
    group: "Python" as const,
    language: "python" as const,
    roles: ["diagnostics"] as LspRole[],
    extensions: PYTHON_EXTENSIONS,
    workspaceRoot: projectRoot,
  };
  specs.push(info.python
    ? runnable(
        basedpyrightBase,
        pyCommand(projectRoot, "basedpyright-langserver", ["--stdio"], ["--from", "basedpyright", "basedpyright-langserver", "--stdio"]),
        "basedpyright-langserver not found and uvx is unavailable",
      )
    : skipped(basedpyrightBase, "no Python project detected"));

  const ruffBase = {
    id: "ruff",
    displayName: "ruff",
    group: "Python" as const,
    language: "python" as const,
    roles: ["format", "lint", "diagnostics"] as LspRole[],
    extensions: PYTHON_EXTENSIONS,
    workspaceRoot: projectRoot,
  };
  specs.push(info.python
    ? runnable(ruffBase, pyCommand(projectRoot, "ruff", ["server"], ["ruff", "server"]), "ruff not found and uvx is unavailable")
    : skipped(ruffBase, "no Python project detected"));

  const tyBase = {
    id: "ty",
    displayName: "ty",
    group: "Python" as const,
    language: "python" as const,
    roles: ["symbols", "navigation"] as LspRole[],
    extensions: PYTHON_EXTENSIONS,
    workspaceRoot: projectRoot,
  };
  specs.push(info.python
    ? runnable(tyBase, pyCommand(projectRoot, "ty", ["server"], ["ty", "server"]), "ty not found and uvx is unavailable")
    : skipped(tyBase, "no Python project detected"));

  const vtslsBase = {
    id: "vtsls",
    displayName: "vtsls",
    group: "Frontend" as const,
    language: "typescript" as const,
    roles: ["diagnostics", "navigation"] as LspRole[],
    extensions: FRONTEND_EXTENSIONS,
    workspaceRoot: info.frontendRoot,
  };
  specs.push(info.frontend
    ? runnable(
        vtslsBase,
        jsCommand(info.frontendRoots, info.frontendRoot, "vtsls", ["--stdio"], { runner: "npx", args: ["-y", "@vtsls/language-server", "--stdio"] }),
        "vtsls not found and npx is unavailable",
      )
    : skipped(vtslsBase, "no JS/TS project detected"));

  const eslintBase = {
    id: "eslint",
    displayName: "eslint",
    group: "Frontend" as const,
    language: "typescript" as const,
    roles: ["lint", "diagnostics"] as LspRole[],
    extensions: FRONTEND_EXTENSIONS,
    workspaceRoot: info.frontendRoot,
  };
  specs.push(info.eslint
    ? runnable(
        eslintBase,
        jsCommand(info.frontendRoots, info.frontendRoot, "vscode-eslint-language-server", ["--stdio"], {
          runner: "npm",
          args: ["exec", "--yes", "--package", "vscode-langservers-extracted", "--", "vscode-eslint-language-server", "--stdio"],
        }),
        "vscode-eslint-language-server not found and npm is unavailable",
      )
    : skipped(eslintBase, "no ESLint config detected"));

  const biomeBase = {
    id: "biome",
    displayName: "biome",
    group: "Frontend" as const,
    language: "typescript" as const,
    roles: ["format", "lint", "diagnostics"] as LspRole[],
    extensions: [...FRONTEND_EXTENSIONS, ...STYLE_EXTENSIONS],
    workspaceRoot: info.frontendRoot,
  };
  specs.push(info.biome
    ? runnable(
        biomeBase,
        jsCommand(info.frontendRoots, info.frontendRoot, "biome", ["lsp-proxy"], {
          runner: "npm",
          args: ["exec", "--yes", "--package", "@biomejs/biome", "--", "biome", "lsp-proxy"],
        }),
        "biome not found and npm is unavailable",
      )
    : skipped(biomeBase, "no Biome config detected"));

  const tailwindBase = {
    id: "tailwindcss",
    displayName: "tailwindcss",
    group: "Frontend" as const,
    language: "css" as const,
    roles: ["tailwind", "diagnostics"] as LspRole[],
    extensions: TAILWIND_EXTENSIONS,
    workspaceRoot: info.frontendRoot,
  };
  specs.push(info.tailwind
    ? runnable(
        tailwindBase,
        jsCommand(info.frontendRoots, info.frontendRoot, "tailwindcss-language-server", ["--stdio"], {
          runner: "npm",
          args: ["exec", "--yes", "--package", "@tailwindcss/language-server", "--", "tailwindcss-language-server", "--stdio"],
        }),
        "tailwindcss-language-server not found and npm is unavailable",
      )
    : skipped(tailwindBase, "no Tailwind config/dependency detected"));

  return specs;
}

export function formatCommand(command: LspCommand | undefined): string {
  if (!command) return "";
  return [command.command, ...command.args].join(" ");
}

export function formatRoot(projectRoot: string, workspaceRoot: string): string {
  const rel = relative(projectRoot, workspaceRoot);
  return rel ? rel : ".";
}
