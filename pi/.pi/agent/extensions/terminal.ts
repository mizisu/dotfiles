import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { errorMessage, openTerminalApp } from "./shared/terminal-app.js";

function openTerminal(ctx: ExtensionContext): Promise<void> {
  return openTerminalApp(ctx, "terminal");
}

export default function terminalExtension(pi: ExtensionAPI) {
  let unsubscribeLegacyShortcut: (() => void) | undefined;

  pi.registerShortcut("ctrl+/", {
    description: "Open terminal",
    handler: openTerminal,
  });

  pi.on("session_start", (_event, ctx) => {
    unsubscribeLegacyShortcut?.();
    unsubscribeLegacyShortcut = undefined;
    if (ctx.mode !== "tui") return;

    // This terminal reports the physical Ctrl+/ chord as CSI-u Ctrl+_.
    // Legacy terminals may instead send the ambiguous 0x1f control byte.
    unsubscribeLegacyShortcut = ctx.ui.onTerminalInput((data) => {
      if (data !== "\x1f" && !matchesKey(data, "ctrl+_")) return undefined;
      void openTerminal(ctx).catch((error) => {
        ctx.ui.notify(`terminal failed: ${errorMessage(error)}`, "error");
      });
      return { consume: true };
    });
  });

  pi.on("session_shutdown", () => {
    unsubscribeLegacyShortcut?.();
    unsubscribeLegacyShortcut = undefined;
  });
}
