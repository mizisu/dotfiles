import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { openTerminalApp } from "./shared/terminal-app.js";

export default function nvimExtension(pi: ExtensionAPI) {
  const open = (ctx: ExtensionContext) => openTerminalApp(ctx, "nvim");
  pi.registerShortcut("ctrl+e", { description: "Open nvim", handler: open });
  pi.registerCommand("nvim", { description: "Open nvim", handler: (_args, ctx) => open(ctx) });
}
