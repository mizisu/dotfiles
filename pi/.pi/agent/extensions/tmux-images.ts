import { execFileSync } from "node:child_process";
import { createHash, randomInt, randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  deleteKittyImage,
  getCapabilities,
  Image,
  ProcessTerminal,
  setCapabilities,
  truncateToWidth,
} from "@earendil-works/pi-tui";

const PATCH = Symbol.for("pi.tmux-images.patch");
const PLACEHOLDER = "\u{10eeee}";
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024;
const MAX_UPLOADS = 128;
// First 128 entries of Kitty's rowcolumn-diacritics.txt, in protocol order.
// https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders
const DIACRITICS = `
0305 030D 030E 0310 0312 033D 033E 033F 0346 034A 034B 034C 0350 0351 0352 0357
035B 0363 0364 0365 0366 0367 0368 0369 036A 036B 036C 036D 036E 036F 0483 0484
0485 0486 0487 0592 0593 0594 0595 0597 0598 0599 059C 059D 059E 059F 05A0 05A1
05A8 05A9 05AB 05AC 05AF 05C4 0610 0611 0612 0613 0614 0615 0616 0617 0657 0658
0659 065A 065B 065D 065E 06D6 06D7 06D8 06D9 06DA 06DB 06DC 06DF 06E0 06E1 06E2
06E4 06E7 06E8 06EB 06EC 0730 0732 0733 0735 0736 073A 073D 073F 0740 0741 0743
0745 0747 0749 074A 07EB 07EC 07ED 07EE 07EF 07F0 07F1 07F3 0816 0817 0818 0819
081B 081C 081D 081E 081F 0820 0821 0822 0823 0825 0826 0827 0829 082A 082B 082C
`.trim().split(/\s+/).map((hex) => String.fromCodePoint(Number.parseInt(hex, 16)));

type Preview = { id: number; bytes: number; sequence: string; lines: string[] };
type RenderCache = { native: string[]; preview: Preview };

function passthrough(sequence: string): string {
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

function tmuxValue(args: string[]): string {
  return execFileSync("tmux", args, {
    encoding: "utf8",
    timeout: 500,
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

/** Keep layout as ordinary text; only upload image bytes at the final terminal-write boundary. */
function install(): () => void {
  const originalRender = Image.prototype.render;
  const originalWrite = ProcessTerminal.prototype.write;
  const previousCapabilities = getCapabilities();
  const capabilities = { ...previousCapabilities, images: "kitty" as const };
  const prefix = `\x1b]777;pi-image-${randomUUID()};`;
  const renders = new WeakMap<Image, RenderCache>();
  const previews = new Map<number, WeakRef<Preview>>();
  const byContent = new Map<string, WeakRef<Preview>>();
  const uploaded = new Map<number, number>();
  const pendingDeletes = new Set<number>();
  const pendingWrites = new Map<ProcessTerminal, string>();
  let uploadedBytes = 0;
  let terminal: ProcessTerminal | undefined;
  let disposed = false;
  const finalized = new FinalizationRegistry<{ id: number; key: string }>(({ id, key }) => {
    if (disposed) return;
    previews.delete(id);
    if (!byContent.get(key)?.deref()) byContent.delete(key);
    if (uploaded.has(id)) pendingDeletes.add(id);
  });

  function forget(id: number, target: ProcessTerminal) {
    const bytes = uploaded.get(id);
    if (bytes === undefined) return;
    originalWrite.call(target, passthrough(deleteKittyImage(id)));
    uploaded.delete(id);
    uploadedBytes -= bytes;
  }

  function upload(preview: Preview, target: ProcessTerminal) {
    const previous = uploaded.get(preview.id);
    if (previous !== undefined) {
      uploaded.delete(preview.id);
      uploaded.set(preview.id, previous);
      return;
    }
    while (uploaded.size >= MAX_UPLOADS || uploadedBytes + preview.bytes > MAX_UPLOAD_BYTES) {
      const oldest = uploaded.keys().next().value;
      if (oldest === undefined) break;
      forget(oldest, target);
    }
    // Native Pi already chunks PNG payloads into Kitty's 4096-byte packets.
    // U=1 creates an invisible virtual placement; the text cells below display it.
    const sequence = preview.sequence.replace("a=T,", "a=T,U=1,").replace(/\bi=\d+/, `i=${preview.id}`);
    for (const match of sequence.matchAll(/\x1b_G[^\x1b]*\x1b\\/g)) {
      originalWrite.call(target, passthrough(match[0]));
    }
    uploaded.set(preview.id, preview.bytes);
    uploadedBytes += preview.bytes;
  }

  function render(this: Image, width: number): string[] {
    const native = originalRender.call(this, Math.min(width, DIACRITICS.length));
    if (getCapabilities().images !== "kitty") return native;
    const cached = renders.get(this);
    if (cached?.native === native) return cached.preview.lines;
    const sequence = native[0] ?? "";
    const header = /^\x1b_G([^;]+);/.exec(sequence)?.[1];
    if (!header) return native;
    const params = Object.fromEntries(header.split(",").map((item) => item.split("=")));
    const columns = Number(params.c);
    const rows = Number(params.r);
    const payloadStart = sequence.indexOf(";") + 1;
    const pngHeader = Buffer.from(sequence.slice(payloadStart, payloadStart + 32), "base64");
    const png = pngHeader.length === 24 && pngHeader.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
    const pixels = png ? pngHeader.readUInt32BE(16) * pngHeader.readUInt32BE(20) : 0;
    const bytes = sequence.length + pixels * 4;
    if (params.a !== "T" || params.f !== "100" || !Number.isInteger(columns) || !Number.isInteger(rows)
      || columns < 1 || columns > Math.min(width, DIACRITICS.length) || rows < 1 || rows > DIACRITICS.length
      || !pixels || bytes > MAX_UPLOAD_BYTES) {
      return [truncateToWidth("[Image preview unavailable in tmux]", width)];
    }
    // Pi can recreate Image components on every tool update; share identical uploads.
    const key = createHash("sha256").update(sequence.replace(/\bi=\d+/, "i=0")).digest("hex");
    let preview = byContent.get(key)?.deref();
    if (!preview) {
      let id: number;
      do { id = randomInt(1, 0x1000000); } while (previews.has(id) || uploaded.has(id));
      const marker = `${prefix}${id}\x07`;
      const color = `\x1b[38;2;${id >> 16};${(id >> 8) & 255};${id & 255}m\x1b[59m`;
      const lines = Array.from({ length: rows }, (_, row) => {
        let cells = "";
        for (let column = 0; column < columns; column++) {
          cells += PLACEHOLDER + DIACRITICS[row] + DIACRITICS[column];
        }
        // A marker on every row also handles a viewport that clips off the top row.
        return `${marker}${color}${cells}\x1b[39m`;
      });
      preview = { id, bytes, sequence, lines };
      previews.set(id, new WeakRef(preview));
      byContent.set(key, new WeakRef(preview));
      finalized.register(preview, { id, key });
    }
    renders.set(this, { native, preview });
    return preview.lines;
  }

  function write(this: ProcessTerminal, data: string) {
    terminal = this;
    for (const id of pendingDeletes) forget(id, this);
    pendingDeletes.clear();
    const input = (pendingWrites.get(this) ?? "") + data;
    pendingWrites.delete(this);
    let offset = 0;
    for (;;) {
      const start = input.indexOf(prefix, offset);
      if (start === -1) break;
      originalWrite.call(this, input.slice(offset, start));
      const end = input.indexOf("\x07", start + prefix.length);
      if (end === -1) {
        pendingWrites.set(this, input.slice(start));
        return;
      }
      const preview = previews.get(Number(input.slice(start + prefix.length, end)))?.deref();
      if (preview) upload(preview, this);
      offset = end + 1;
    }
    let tail = input.slice(offset);
    // Pi's bounded writer may split an OSC marker between write() calls.
    const escape = tail.lastIndexOf("\x1b");
    if (escape !== -1 && prefix.startsWith(tail.slice(escape))) {
      pendingWrites.set(this, tail.slice(escape));
      tail = tail.slice(0, escape);
    }
    if (tail) originalWrite.call(this, tail);
  }

  // Resizing changes the native placement dimensions and therefore its cache key.
  // Do not clear uploads on SIGWINCH: a same-size event need not repaint image rows.
  Image.prototype.render = render;
  ProcessTerminal.prototype.write = write;
  setCapabilities(capabilities);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (terminal) {
      for (const id of uploaded.keys()) forget(id, terminal);
    }
    pendingWrites.clear();
    previews.clear();
    byContent.clear();
    if (Image.prototype.render === render) Image.prototype.render = originalRender;
    if (ProcessTerminal.prototype.write === write) ProcessTerminal.prototype.write = originalWrite;
    if (getCapabilities() === capabilities) setCapabilities(previousCapabilities);
    if (Reflect.get(Image.prototype, PATCH) === dispose) Reflect.deleteProperty(Image.prototype, PATCH);
  };
  Reflect.set(Image.prototype, PATCH, dispose);
  return dispose;
}

export default function tmuxImages(pi: ExtensionAPI) {
  let dispose: (() => void) | undefined;
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || !process.env.TMUX || !process.env.TMUX_PANE || dispose) return;
    const protocol = pi.getSettings().terminal?.images ?? process.env.PI_IMAGE_PROTOCOL ?? "auto";
    if (protocol !== "auto" && protocol !== "kitty") return;
    if (Reflect.has(Image.prototype, PATCH)) return;
    try {
      const client = tmuxValue(["display-message", "-p", "-t", process.env.TMUX_PANE, "#{client_termname}"]);
      if (client !== "xterm-kitty") return;
      const allowed = tmuxValue(["show-options", "-p", "-A", "-v", "-t", process.env.TMUX_PANE, "allow-passthrough"]);
      if (allowed !== "on" && allowed !== "all") {
        ctx.ui.notify("Image previews in Kitty + tmux require allow-passthrough on. No tmux settings were changed.", "warning");
        return;
      }
      dispose = install();
    } catch {
      ctx.ui.notify("Could not enable Kitty image previews in tmux; keeping Pi's default renderer.", "warning");
    }
  });
  pi.on("session_shutdown", () => {
    dispose?.();
    dispose = undefined;
  });
}
