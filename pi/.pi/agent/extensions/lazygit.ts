import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openTerminalApp } from "./shared/terminal-app.js";

export default function lazygitExtension(pi: ExtensionAPI) {
  const open = (ctx: ExtensionContext) => openTerminalApp(ctx, "lazygit");
  pi.registerShortcut("ctrl+g", { description: "Open lazygit", handler: open });
  pi.registerCommand("lazygit", { description: "Open lazygit", handler: (_args, ctx) => open(ctx) });
}
