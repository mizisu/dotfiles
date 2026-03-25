import { resolve, dirname } from "node:path";
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
  settings?: Record<string, any>;
}

export function detectServers(projectRoot: string): ServerConfig[] {
  const servers: ServerConfig[] = [];

  // TypeScript — typescript-language-server
  const tsConfigPaths = [
    resolve(projectRoot, "app/tsconfig.json"),
    resolve(projectRoot, "tsconfig.json"),
  ];
  const tsConfig = tsConfigPaths.find((p) => existsSync(p));
  if (tsConfig) {
    const tsRoot = dirname(tsConfig);
    const localTsServer = resolve(tsRoot, "node_modules/.bin/typescript-language-server");
    const useLocal = existsSync(localTsServer);

    servers.push({
      name: "typescript",
      command: useLocal ? localTsServer : "npx",
      args: useLocal ? ["--stdio"] : ["typescript-language-server", "--stdio"],
      language: "typescript",
      extensions: [".ts", ".tsx", ".js", ".jsx"],
      workspaceSubdir: tsRoot !== projectRoot ? "app" : undefined,
    });
  }

  // Python — ty (fast Rust-based type checker from Astral, with full LSP)
  const hasPython =
    existsSync(resolve(projectRoot, "pyproject.toml")) ||
    existsSync(resolve(projectRoot, "manage.py"));

  if (hasPython) {
    servers.push({
      name: "ty",
      command: "uvx",
      args: ["ty", "server"],
      language: "python",
      extensions: [".py"],
    });
    servers.push({
      name: "pyright",
      command: "npx",
      args: ["-p", "pyright", "pyright-langserver", "--stdio"],
      language: "python",
      extensions: [".py"],
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
  }

  return servers;
}
