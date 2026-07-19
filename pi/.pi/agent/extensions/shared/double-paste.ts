import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const DOUBLE_PASTE_WINDOW_MS = 3_000;

export type PasteCandidate = {
  pasteFingerprint: string;
  editorFingerprint: string;
  armedAt: number;
};

export function fingerprint(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function longPasteFingerprint(data: string): string | undefined {
  if (!data.startsWith(PASTE_START) || !data.endsWith(PASTE_END)) return undefined;

  const text = data
    .slice(PASTE_START.length, -PASTE_END.length)
    .replace(/\x1b\[(\d+);5u/g, (match, code: string) => {
      const codePoint = Number(code);
      if (codePoint >= 97 && codePoint <= 122) return String.fromCharCode(codePoint - 96);
      if (codePoint >= 65 && codePoint <= 90) return String.fromCharCode(codePoint - 64);
      return match;
    })
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .split("")
    .filter((character) => character === "\n" || character.charCodeAt(0) >= 32)
    .join("");

  if (text.split("\n").length <= 10 && text.length <= 1_000) return undefined;
  return fingerprint(text);
}

export function isMatchingDoublePaste(
  candidate: PasteCandidate | undefined,
  pasteFingerprint: string,
  editorText: string,
  now: number,
): boolean {
  return Boolean(
    candidate &&
      now - candidate.armedAt <= DOUBLE_PASTE_WINDOW_MS &&
      candidate.pasteFingerprint === pasteFingerprint &&
      candidate.editorFingerprint === fingerprint(editorText),
  );
}

function selfCheck(): void {
  const content = Array.from({ length: 11 }, (_, index) => `line ${index}`).join("\r\n");
  const paste = longPasteFingerprint(`${PASTE_START}${content}${PASTE_END}`);
  assert.ok(paste);

  const candidate = {
    pasteFingerprint: paste,
    editorFingerprint: fingerprint("editor"),
    armedAt: 1_000,
  };
  assert.equal(isMatchingDoublePaste(candidate, paste, "editor", 4_000), true);
  assert.equal(isMatchingDoublePaste(candidate, paste, "editor", 4_001), false);
  assert.equal(isMatchingDoublePaste(candidate, paste, "edited", 2_000), false);
  assert.equal(longPasteFingerprint(`${PASTE_START}short${PASTE_END}`), undefined);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  selfCheck();
  console.log("double-paste self-check passed");
}
