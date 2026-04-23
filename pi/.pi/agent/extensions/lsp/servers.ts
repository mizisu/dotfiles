import { resolve, dirname, relative } from "node:path";
import { existsSync } from "node:fs";

export interface ServerConfig {
  name: string;
  command: string;
  args: string[];
  language: string;
  extensions: string[];
  env?: Record<string, string>;
  workspaceSubdir?: string;
  diagnosticsOnly?: boolean;
  diagnostics?: boolean;
  formatOnSave?: boolean;
  fixOnSaveKinds?: string[];
  sendDidSave?: boolean;
  settings?: Record<string, any>;
}
function firstExisting(paths: string[]): string | null {
  for (const path of paths) {
    if (existsSync(path)) return path;
  }
  return null;
}

function localBin(roots: string[], name: string): string | null {
  return firstExisting(roots.map((root) => resolve(root, "node_modules/.bin", name)));
}

function hasAny(root: string, names: string[]): boolean {
  return names.some((name) => existsSync(resolve(root, name)));
}

function detectPackageManager(roots: string[]): "npm" | "pnpm" | "yarn" {
  if (roots.some((root) => existsSync(resolve(root, "pnpm-lock.yaml")))) return "pnpm";
  if (roots.some((root) => existsSync(resolve(root, "yarn.lock")))) return "yarn";
  return "npm";
}

function hasBiomeConfig(roots: string[]): boolean {
  return roots.some((root) => hasAny(root, ["biome.json", "biome.jsonc"]));
}

function hasEslintConfig(roots: string[]): boolean {
  return roots.some((root) => hasAny(root, [
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
  ]));
}

export function detectServers(projectRoot: string): ServerConfig[] {
  const servers: ServerConfig[] = [];

  const tsConfigPaths = [
    resolve(projectRoot, "app/tsconfig.json"),
    resolve(projectRoot, "tsconfig.json"),
  ];
  const tsConfig = tsConfigPaths.find((path) => existsSync(path));
  const frontendRoot = tsConfig
    ? dirname(tsConfig)
    : existsSync(resolve(projectRoot, "app/package.json"))
      ? resolve(projectRoot, "app")
      : projectRoot;
  const frontendRoots = [...new Set([frontendRoot, projectRoot])];
  const workspaceSubdir = frontendRoot !== projectRoot ? relative(projectRoot, frontendRoot) || undefined : undefined;
  const packageManager = detectPackageManager(frontendRoots);

  if (tsConfig) {
    const localTsServer = localBin(frontendRoots, "typescript-language-server");
    servers.push({
      name: "typescript",
      command: localTsServer ?? "npx",
      args: localTsServer ? ["--stdio"] : ["-y", "typescript-language-server", "--stdio"],
      language: "typescript",
      extensions: [".ts", ".tsx", ".js", ".jsx"],
      workspaceSubdir,
    });
  }

  if (hasEslintConfig(frontendRoots)) {
    const localEslint = localBin(frontendRoots, "vscode-eslint-language-server");
    servers.push({
      name: "eslint",
      command: localEslint ?? "npm",
      args: localEslint
        ? ["--stdio"]
        : ["exec", "--yes", "--package", "vscode-langservers-extracted", "--", "vscode-eslint-language-server", "--stdio"],
      language: "typescript",
      extensions: [".ts", ".tsx", ".js", ".jsx"],
      workspaceSubdir,
      diagnosticsOnly: true,
      fixOnSaveKinds: ["source.fixAll.eslint"],
      settings: {
        validate: "probe",
        packageManager,
        codeActionOnSave: {
          mode: "all",
        },
        problems: {},
        rulesCustomizations: [],
        nodePath: "",
        experimental: {
          useFlatConfig: false,
        },
      },
    });
  }

  if (hasBiomeConfig(frontendRoots)) {
    const localBiome = localBin(frontendRoots, "biome");
    servers.push({
      name: "biome",
      command: localBiome ?? "npm",
      args: localBiome
        ? ["lsp-proxy"]
        : ["exec", "--yes", "--package", "@biomejs/biome", "--", "biome", "lsp-proxy"],
      language: "typescript",
      extensions: [".ts", ".tsx", ".js", ".jsx", ".css", ".scss", ".sass"],
      workspaceSubdir,
      diagnosticsOnly: true,
      formatOnSave: true,
    });
  }

  const hasPython =
    existsSync(resolve(projectRoot, "pyproject.toml")) ||
    existsSync(resolve(projectRoot, "manage.py"));

  if (hasPython) {
    servers.push({
      name: "ty",
      command: "uvx",
      args: ["ty", "server"],
      language: "python",
      extensions: [".py", ".pyi"],
      diagnostics: false,
    });
    servers.push({
      name: "pyright",
      command: "npx",
      args: ["-p", "pyright", "pyright-langserver", "--stdio"],
      language: "python",
      extensions: [".py", ".pyi"],
      diagnosticsOnly: true,
      settings: {
        python: {
          analysis: {
            typeCheckingMode: "standard",
            diagnosticMode: "openFilesOnly",
          },
        },
      },
    });
    servers.push({
      name: "ruff",
      command: "uvx",
      args: ["ruff", "server"],
      language: "python",
      extensions: [".py", ".pyi"],
      diagnosticsOnly: true,
      formatOnSave: true,
      fixOnSaveKinds: ["source.fixAll.ruff", "source.organizeImports.ruff"],
    });
  }

  return servers;
}
