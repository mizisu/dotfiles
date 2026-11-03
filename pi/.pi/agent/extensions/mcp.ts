import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import {
  createMcpExtension,
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type McpServerConfig,
} from "@earendil-works/pi-coding-agent";

function resolveSecrets(config: McpServerConfig): McpServerConfig {
  if (!JSON.stringify(config).includes("${")) return config;
  const envPath = join(getAgentDir(), ".env.mcp");
  const secrets = existsSync(envPath) ? parseEnv(readFileSync(envPath, "utf8")) : {};
  const resolve = (value: string) =>
    value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (reference, name) => secrets[name] ?? reference);
  const values = (record: Record<string, string>) =>
    Object.fromEntries(Object.entries(record).map(([name, value]) => [name, resolve(value)]));
  if ("command" in config) return { ...config, ...(config.env && { env: values(config.env) }) };
  return {
    ...config,
    ...(config.headers && { headers: values(config.headers) }),
    ...(config.oauth?.clientSecret && {
      oauth: { ...config.oauth, clientSecret: resolve(config.oauth.clientSecret) },
    }),
  };
}

export default function (pi: ExtensionAPI) {
  const configs = new Map<string, McpServerConfig>();
  let changed: (() => void) | undefined;
  let managing = false;
  let previousDiscovery: Set<string> | undefined;

  async function changeRegistration(change: () => void) {
    const settled = new Promise<void>(resolve => { changed = resolve; });
    try {
      change();
      await settled;
    } finally {
      changed = undefined;
    }
  }

  createMcpExtension({
    loadConfig(ctx) {
      for (const name of configs.keys()) pi.unregisterMcpServer(name);
      configs.clear();
      previousDiscovery = undefined;
      const errors: string[] = [];
      let autoEnableCodemode = true;
      const paths = [{ path: join(getAgentDir(), "mcp.json"), scope: "global" }];
      if (ctx.isProjectTrusted()) paths.push({ path: join(ctx.cwd, ".pi", "mcp.json"), scope: "project" });
      for (const { path, scope } of paths) {
        if (!existsSync(path)) continue;
        try {
          const file = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
          if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("Expected an object");
          if (file.mcpServers != null && (typeof file.mcpServers !== "object" || Array.isArray(file.mcpServers))) {
            throw new Error("mcpServers must be an object");
          }
          if (typeof file.autoEnableCodemode === "boolean") autoEnableCodemode = file.autoEnableCodemode;
          for (const [name, config] of Object.entries(file.mcpServers ?? {})) {
            // Preserve native file-scope restrictions before converting to extension registrations.
            if (scope === "project" && config && typeof config === "object" && "auth" in config) {
              errors.push(`${path}: server "${name}": auth is only allowed in the global mcp.json`);
              continue;
            }
            configs.set(name, { ...(config as McpServerConfig), enabled: false });
          }
        } catch {
          errors.push(`Could not load MCP configuration from ${path}`);
        }
      }
      for (const [name, config] of configs) {
        try {
          pi.registerMcpServer(name, config);
        } catch {
          configs.delete(name);
          errors.push(`Invalid MCP server configuration: ${name}`);
        }
      }
      // Extension registrations keep native manager state session-local; never rewrite mcp.json.
      return { servers: [], errors, autoEnableCodemode };
    },
  })({
    ...pi,
    registerCommand(name, command) {
      if (name !== "mcp") return pi.registerCommand(name, command);
      // Pi 0.99 has no public manager-state callback. Read its own status after UI changes;
      // never infer enabled/exposure from tool count (failed or hidden servers can still be ON).
      async function syncState(ctx: ExtensionCommandContext) {
        let status = "";
        await command.handler("", {
          ...ctx, mode: "print", ui: { ...ctx.ui, notify: message => { status = message; } },
        });
        const seen = new Set<string>();
        let anyEnabled = false;
        for (const line of status.split("\n")) {
          const match = /^([\w-]+): (disabled|starting|connecting|connected|disconnected|needs sign-in|failed|closed)\b[^\n]* \((codemode-deferred|codemode|deferred|direct|hidden)\)$/.exec(line);
          if (!match) continue;
          const [, server, state, exposure] = match;
          seen.add(server);
          const enabled = state !== "disabled";
          anyEnabled ||= enabled;
          const config = configs.get(server);
          if (config) configs.set(server, { ...config, enabled, exposure: exposure as McpServerConfig["exposure"] });
        }
        if ([...configs.keys()].some(server => !seen.has(server))) {
          throw new Error("Native MCP status format changed; toggle state cannot be synchronized");
        }
        if (!anyEnabled && previousDiscovery) {
          pi.setActiveTools(pi.getActiveTools().filter(tool =>
            (tool !== "codemode" && tool !== "tool_search") || previousDiscovery?.has(tool),
          ));
          previousDiscovery = undefined;
        }
      }
      return pi.registerCommand(name, {
        ...command,
        description: "Open the native MCP manager, or toggle a server for this session: /mcp <server>.",
        getArgumentCompletions(prefix) {
          const matches = [...configs.keys()]
            .filter(server => server.startsWith(prefix.trimStart()))
            .map(server => ({ value: server, label: server }));
          return matches.length ? matches : command.getArgumentCompletions?.(prefix) ?? null;
        },
        async handler(args, ctx) {
          if (managing) {
            ctx.ui.notify("An MCP command is already in progress.", "warning");
            return;
          }
          managing = true;
          try {
            await ctx.waitForIdle();
            await syncState(ctx);
            previousDiscovery ??= new Set(pi.getActiveTools());
            const server = args.trim();
            const config = configs.get(server);
            if (config) {
              const next = { ...config, enabled: config.enabled === false };
              const resolved = next.enabled ? resolveSecrets(next) : next;
              // The manager mutates its own state, not the registration. Replace only this server
              // so a UI enable followed by a shortcut disable cannot look like an unchanged config.
              await changeRegistration(() => pi.unregisterMcpServer(server));
              configs.delete(server);
              await changeRegistration(() => pi.registerMcpServer(server, resolved));
              configs.set(server, next);
              ctx.ui.notify(`MCP ${server}: ${next.enabled ? "ON" : "OFF"} (this session only)`, "info");
              await command.handler("", { ...ctx, mode: "print" });
            } else {
              if (!server && ctx.mode === "tui") {
                // Prepare local credentials for servers the user may enable in the native UI.
                // Disabled registrations do not connect, and active connections are left alone.
                for (const [name, config] of configs) {
                  if (config.enabled !== false) continue;
                  try {
                    const resolved = resolveSecrets(config);
                    const registered = pi.getMcpServers().find(entry => entry.name === name);
                    if (JSON.stringify(resolved) !== JSON.stringify(registered?.config)) {
                      await changeRegistration(() => pi.registerMcpServer(name, resolved));
                    }
                  } catch {
                    ctx.ui.notify(`Could not prepare local credentials for "${name}"; the manager is still available.`, "warning");
                  }
                }
              }
              await command.handler(args, ctx);
            }
          } catch {
            ctx.ui.notify("Could not complete the MCP command. Check native MCP status and local configuration.", "error");
          } finally {
            try { await syncState(ctx); }
            catch { ctx.ui.notify("Could not synchronize native MCP state; run /reload before toggling.", "error"); }
            managing = false;
          }
        },
      });
    },
  });
  // Native connection/disconnection handlers finish before this observer resolves the command.
  pi.on("mcp_servers_change", () => { changed?.(); });
}
