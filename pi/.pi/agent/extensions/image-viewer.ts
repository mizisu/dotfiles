import {
  convertToPng,
  ToolExecutionComponent,
  type ExtensionAPI,
  type ExtensionContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  getCapabilities,
  Image,
  matchesKey,
  Spacer,
  truncateToWidth,
  visibleWidth,
  type Component,
  type ImageOptions,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";

const PATCH = Symbol.for("pi.image-viewer.patch");
type ImageSource = { data: string; mimeType: string; filename?: string };
type MouseImage = Image & Pick<Component, "handleMouse">;

// Pi has no image-click hook or source getter. Keep the private-field dependency here;
// leave Image.render() alone, since tmux-images.ts also wraps it.
function imageSource(image: Image): ImageSource | undefined {
  const data = Reflect.get(image, "base64Data");
  const mimeType = Reflect.get(image, "mimeType");
  const filename = Reflect.get(image, "options")?.filename;
  if (typeof data !== "string" || !data || typeof mimeType !== "string") return undefined;
  return { data, mimeType, filename: typeof filename === "string" ? filename : undefined };
}

// Native image lines have zero text width; tmux previews use visible Unicode cells.
// Read only the protocol header, never scan the entire base64 payload for layout.
function imageColumns(lines: string[]): number {
  const kitty = /^\x1b_G[^;]*\bc=(\d+)(?:,|;)/.exec((lines[0] ?? "").slice(0, 256));
  if (kitty) return Number(kitty[1]);
  const iterm = /\x1b\]1337;File=[^:]*;width=(\d+)(?:;|:)/.exec((lines.at(-1) ?? "").slice(0, 256));
  if (iterm) return Number(iterm[1]);
  return Math.max(0, ...lines.map((line) => visibleWidth(line)));
}

// Pi's overlay compositor deliberately preserves native image lines instead of
// covering them. For this full-viewport modal, blank those background anchors at
// the composition boundary (not Image.render, so cached parents/tmux still work).
// This is a private TUI hook; scope it to this interaction and restore it exactly.
function hideUnderlyingImages(tui: TUI): () => void {
  const key = "compositeOverlays";
  const original = Reflect.get(tui, key);
  if (typeof original !== "function") throw new Error("This Pi version does not support image overlays.");
  const descriptor = Object.getOwnPropertyDescriptor(tui, key);
  function composite(this: TUI, lines: string[], width: number, height: number): string[] {
    const background = lines.map((line) => /\x1b(?:_G|\]1337;File=)/.test(line) ? "" : line);
    return original.call(this, background, width, height);
  }
  Reflect.set(tui, key, composite);
  return () => {
    if (Reflect.get(tui, key) !== composite) return;
    if (descriptor) Object.defineProperty(tui, key, descriptor);
    else Reflect.deleteProperty(tui, key);
  };
}

function plainClick(event: TuiMouseEvent): boolean {
  return event.type === "click" && event.button === "left" && !event.shift && !event.alt && !event.ctrl;
}

class ImageOverlay implements Component {
  private readonly options: ImageOptions = {};
  private readonly image: Image;
  private readonly restoreImages: () => void;
  private disposed = false;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly source: ImageSource,
    private readonly done: () => void,
  ) {
    this.image = new Image(source.data, source.mimeType, {
      fallbackColor: (text) => theme.fg("muted", text),
    }, this.options);
    this.restoreImages = hideUnderlyingImages(tui);
  }

  render(width: number): string[] {
    const height = Math.max(1, this.tui.terminal.rows);
    if (width < 4 || height < 3) {
      this.image.invalidate();
      return [truncateToWidth("Esc to close", width), ...Array<string>(height - 1).fill("")];
    }
    const maxWidth = width - 2;
    const maxHeight = height - 2;
    if (this.options.maxWidthCells !== maxWidth || this.options.maxHeightCells !== maxHeight) {
      this.options.maxWidthCells = maxWidth;
      this.options.maxHeightCells = maxHeight;
      this.image.invalidate();
    }
    const imageLines = this.image.render(width);
    const left = " ".repeat(Math.max(0, Math.floor((width - imageColumns(imageLines)) / 2)));
    const top = 1 + Math.max(0, Math.floor((maxHeight - imageLines.length) / 2));
    // Cover the whole viewport; native background anchors are suppressed before compositing.
    const lines = Array<string>(height).fill("");
    const name = this.source.filename?.replace(/[\x00-\x1f\x7f-\x9f]/g, "") ?? "Image";
    lines[0] = this.theme.fg("accent", truncateToWidth(` ${name}`, width));
    for (let row = 0; row < imageLines.length && top + row < height - 1; row++) {
      lines[top + row] = left + imageLines[row];
    }
    lines[height - 1] = this.theme.fg("muted", truncateToWidth(" Esc / q / click to close", width));
    return lines;
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) this.done();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    if (plainClick(event)) this.done();
    // Do not let clicks or wheel events reach the transcript behind this modal.
    return { handled: true };
  }

  invalidate(): void {
    this.image.invalidate();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.restoreImages();
    // A forced repaint emits ED2, which drops Kitty image data without clearing
    // Pi's upload cache. Diff away the modal instead, and invalidate components
    // so originals are re-uploaded even if a resize cleared them while hidden.
    this.tui.invalidate();
    this.tui.requestRender();
  }
}

function installClicks(open: (source: ImageSource) => void): (() => void) | undefined {
  const prototype = Image.prototype as MouseImage;
  if (Reflect.has(prototype, PATCH)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "handleMouse");
  const originalImageMouse = prototype.handleMouse;
  const originalToolMouse = ToolExecutionComponent.prototype.handleMouse;
  let disposed = false;

  function imageMouse(this: MouseImage, event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const previous = originalImageMouse?.call(this, event);
    if (previous || disposed || !plainClick(event) || !getCapabilities().images) return previous;
    const lines = this.render(event.width);
    if (event.x < 0 || event.x >= imageColumns(lines) || event.y < 0 || event.y >= lines.length) return undefined;
    const source = imageSource(this);
    if (!source) return undefined;
    open(source);
    return { handled: true };
  }

  function toolMouse(this: ToolExecutionComponent, event: TuiMouseEvent) {
    const previous = originalToolMouse.call(this, event);
    if (previous || disposed || !plainClick(event)) return previous;
    // Pi's renderShell="self" dispatch skips images appended after the custom content.
    // Their public trailing children still match the rendered layout (Spacer, Image).
    let bottom = event.height;
    for (let index = this.children.length - 1; index >= 0; index--) {
      const child = this.children[index];
      if (!(child instanceof Image) && !(child instanceof Spacer)) break;
      const height = child.render(event.width).length;
      bottom -= height;
      if (child instanceof Image && event.y >= bottom && event.y < bottom + height) {
        const target = new Container();
        target.addChild(child);
        return target.handleMouse({ ...event, y: event.y - bottom, height });
      }
    }
    return undefined;
  }

  prototype.handleMouse = imageMouse;
  ToolExecutionComponent.prototype.handleMouse = toolMouse;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (prototype.handleMouse === imageMouse) {
      if (descriptor) Object.defineProperty(prototype, "handleMouse", descriptor);
      else delete prototype.handleMouse;
    }
    if (ToolExecutionComponent.prototype.handleMouse === toolMouse) {
      ToolExecutionComponent.prototype.handleMouse = originalToolMouse;
    }
    if (Reflect.get(prototype, PATCH) === dispose) Reflect.deleteProperty(prototype, PATCH);
  };
  Reflect.set(prototype, PATCH, dispose);
  return dispose;
}

export default function imageViewer(pi: ExtensionAPI) {
  let disposeClicks: (() => void) | undefined;
  let closeOverlay: (() => void) | undefined;
  let generation = 0;
  let viewing = false;

  async function show(source: ImageSource, ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Image viewer requires Pi's interactive terminal UI.", "warning");
      return;
    }
    if (!getCapabilities().images) {
      ctx.ui.notify("This terminal does not support inline images.", "warning");
      return;
    }
    if (viewing) return;
    viewing = true;
    const currentGeneration = generation;
    let overlay: ImageOverlay | undefined;
    try {
      const png = await convertToPng(source.data, source.mimeType);
      if (currentGeneration !== generation) return;
      if (!png) throw new Error("Could not convert this image for display.");
      await ctx.ui.custom<void>((tui, theme, _keys, done) => {
        closeOverlay = () => done();
        overlay = new ImageOverlay(tui, theme, { ...source, ...png }, closeOverlay);
        return overlay;
      }, {
        overlay: true,
        overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center" },
      });
    } catch (error) {
      if (currentGeneration === generation) {
        ctx.ui.notify(`Image viewer: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    } finally {
      // Also restore the hook if custom UI fails or closes before Pi mounts it.
      overlay?.dispose();
      if (currentGeneration === generation) {
        viewing = false;
        closeOverlay = undefined;
      }
    }
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui" || disposeClicks) return;
    disposeClicks = installClicks((source) => { void show(source, ctx); });
  });

  pi.on("session_shutdown", () => {
    generation++;
    closeOverlay?.();
    closeOverlay = undefined;
    viewing = false;
    disposeClicks?.();
    disposeClicks = undefined;
  });

}
