import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";

class CursorAwareTriggerEditor extends CustomEditor {
	private shouldOpenPicker(): boolean {
		const { line, col } = this.getCursor();
		if (col === 0) return true;

		const currentLine = this.getLines()[line] ?? "";
		const prevChar = currentLine[col - 1] ?? "";
		return /\s/.test(prevChar);
	}

	private handleTriggerChar(char: "@" | "#"): void {
		if (this.shouldOpenPicker() && this.onExtensionShortcut?.(char)) {
			return;
		}
		this.insertTextAtCursor(char);
	}

	handleInput(data: string): void {
		if (data === "@" || data === "#") {
			this.handleTriggerChar(data);
			return;
		}
		super.handleInput(data);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, keybindings) => new CursorAwareTriggerEditor(tui, theme, keybindings));
	});
}
