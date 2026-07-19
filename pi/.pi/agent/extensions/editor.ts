import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import {
  fingerprint,
  isMatchingDoublePaste,
  longPasteFingerprint,
  type PasteCandidate,
} from "./shared/double-paste.ts";

const PICKER_TRIGGER_CHARS = new Set(["@", "#"]);

class PiEditor extends CustomEditor {
  private pasteCandidate: PasteCandidate | undefined;

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

  private handleDoublePaste(data: string): boolean {
    const pasteFingerprint = longPasteFingerprint(data);
    if (!pasteFingerprint) return false;

    const editorText = this.getExpandedText();
    if (isMatchingDoublePaste(this.pasteCandidate, pasteFingerprint, editorText, Date.now())) {
      this.setText(editorText);
      this.pasteCandidate = undefined;
      return true;
    }

    super.handleInput(data);
    const updatedEditorText = this.getExpandedText();
    this.pasteCandidate =
      updatedEditorText === editorText
        ? undefined
        : {
            pasteFingerprint,
            editorFingerprint: fingerprint(updatedEditorText),
            armedAt: Date.now(),
          };
    return true;
  }

  handleInput(data: string): void {
    // ponytail: this editor already owns paste input, so no second extension or listener.
    if (this.handleDoublePaste(data)) return;

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
