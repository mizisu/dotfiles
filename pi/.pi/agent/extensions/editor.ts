import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PICKER_TRIGGER_CHARS = new Set(["@", "#"]);

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

  handleInput(data: string): void {
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
