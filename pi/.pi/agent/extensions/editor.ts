import {
  CustomEditor,
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, renderFakeCursor, sliceByColumn, visibleWidth } from "@earendil-works/pi-tui";
import { registerEditorPrediction } from "./shared/editor-prediction.ts";
import {
  fingerprint,
  isMatchingDoublePaste,
  longPasteFingerprint,
  type PasteCandidate,
} from "./shared/double-paste.ts";

const PICKER_TRIGGER_CHARS = new Set(["@", "#"]);

class PiEditor extends CustomEditor {
  private pasteCandidate: PasteCandidate | undefined;
  private predictionPreview: ((width: number) => string) | undefined;
  onEdit?: () => void;
  onPredictionInput?: (data: string) => boolean;

  setPredictionPreview(preview: ((width: number) => string) | undefined): void {
    this.predictionPreview = preview;
    this.invalidate();
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const lines = super.render(width);
    const preview = this.predictionPreview;
    if (!preview || width < 1) return lines;

    const row = lines.findIndex((line) => line.includes(CURSOR_MARKER));
    if (row < 0) return lines;
    const prefix = lines[row].slice(0, lines[row].indexOf(CURSOR_MARKER));
    const padding = visibleWidth(prefix);
    // shortcut: Clip previews to one line; use editor-aware wrapping if multiline previews are needed.
    const text = preview(width - padding * 2);
    if (!text) return lines;
    const first = sliceByColumn(text, 0, 1);
    const rest = sliceByColumn(text, visibleWidth(first), width);
    lines[row] = prefix + CURSOR_MARKER + renderFakeCursor(first) + rest
      + " ".repeat(Math.max(0, width - padding - visibleWidth(text)));
    return lines;
  }

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

  setText(text: string): void {
    this.onEdit?.();
    super.setText(text);
  }

  insertTextAtCursor(text: string): void {
    if (text) this.onEdit?.();
    super.insertTextAtCursor(text);
  }

  handleInput(data: string): void {
    const previous = this.getText();
    try {
      if (this.handleDoublePaste(data)) return;
      if (this.onPredictionInput?.(data)) return;

      if (PICKER_TRIGGER_CHARS.has(data)) {
        this.handlePickerTrigger(data);
        return;
      }

      super.handleInput(data);
    } finally {
      if (this.getText() !== previous) this.onEdit?.();
    }
  }
}

export default function editorExtension(pi: ExtensionAPI) {
  let editor: PiEditor | undefined;
  const prediction = registerEditorPrediction(pi, () => editor);

  pi.on("session_shutdown", () => {
    editor = undefined;
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    const settings = SettingsManager.create(ctx.cwd, getAgentDir(), {
      projectTrusted: ctx.isProjectTrusted(),
    });
    const options = {
      paddingX: settings.getEditorPaddingX(),
      autocompleteMaxVisible: settings.getAutocompleteMaxVisible(),
      embedWorkingStatus: true,
    } as const;

    ctx.ui.setEditorComponent((tui, theme, keybindings) => {
      editor = new PiEditor(tui, theme, keybindings, options);
      editor.onEdit = prediction.onEdit;
      editor.onPredictionInput = (data) => keybindings.matches(data, "tui.input.tab")
        && prediction.accept();
      return editor;
    });
  });
}
