import { spawnSync } from "node:child_process";
import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { matchesKey, type KeyId } from "@mariozechner/pi-tui";

const PICKER_TRIGGER_CHARS = new Set(["@", "#"]);
const EXPANDED_PASTE_KEY = "ctrl+x" as const satisfies KeyId;

function runClipboardCommand(command: string, args: string[]): string | undefined {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.error || result.status !== 0) return undefined;
  return result.stdout ?? "";
}

function readClipboardText(): string | undefined {
  if (process.platform === "darwin") return runClipboardCommand("pbpaste", []);

  if (process.platform === "win32") {
    return runClipboardCommand("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"]);
  }

  if (process.env.TERMUX_VERSION) return runClipboardCommand("termux-clipboard-get", []);

  if (process.env.WAYLAND_DISPLAY) {
    const text = runClipboardCommand("wl-paste", ["--no-newline"]);
    if (text !== undefined) return text;
  }

  return (
    runClipboardCommand("xclip", ["-selection", "clipboard", "-o"]) ??
    runClipboardCommand("xsel", ["--clipboard", "--output"])
  );
}

function cleanPastedText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "    ")
    .split("")
    .filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
    .join("");
}

class PiEditor extends CustomEditor {
  private isPickerTriggerAllowed(): boolean {
    const { line, col } = this.getCursor();
    if (col <= 0) return true;

    const currentLine = this.getLines()[line] ?? "";
    const previousChar = currentLine[col - 1] ?? "";
    return /\s/.test(previousChar);
  }

  private handlePickerTrigger(char: string): void {
    if (this.isPickerTriggerAllowed() && this.onExtensionShortcut?.(char)) return;
    this.insertTextAtCursor(char);
  }

  private handleExpandedClipboardPaste(): void {
    const text = readClipboardText();
    if (!text) return;

    const cleanText = cleanPastedText(text);
    if (!cleanText) return;

    this.insertTextAtCursor(cleanText);
  }

  handleInput(data: string): void {
    if (matchesKey(data, EXPANDED_PASTE_KEY)) {
      this.handleExpandedClipboardPaste();
      return;
    }

    if (PICKER_TRIGGER_CHARS.has(data)) {
      this.handlePickerTrigger(data);
      return;
    }

    super.handleInput(data);
  }
}

export default function editorExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new PiEditor(tui, theme, keybindings));
  });
}
