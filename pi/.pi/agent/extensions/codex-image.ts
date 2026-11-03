import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, getCapabilities, hyperlink, Image, Spacer, Text } from "@earendil-works/pi-tui";

const PROVIDER = "openai-codex";
const DEFAULT_OPTIONS = {
  model: "gpt-image-2.5-flare",
  quality: "auto",
  size: "1024x1024",
  n: 1,
  background: "auto",
} as const;
const TOOL = "generate_image";
// ponytail: Codex's private API can change; follow upstream ImagesClient rather than falling back to a paid API.
const ENDPOINT = "https://chatgpt.com/backend-api/codex/images/generations";
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;

type ImagePreview = {
  path: string;
  data?: string;
  unavailable?: boolean;
  image?: Image;
  theme?: Theme;
  width?: number;
};

// Load only into renderer state, never into tool content or persisted details.
async function readPreview(path: string): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size < 24 || stat.size > MAX_IMAGE_BYTES) throw new Error("Invalid preview file");
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) throw new Error("Incomplete preview file");
      offset += bytesRead;
    }
    if (!bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) throw new Error("Not a PNG");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    if (!width || !height || width * height > 16_000_000) throw new Error("Preview dimensions exceed the limit");
    return bytes.toString("base64");
  } finally {
    await file.close();
  }
}

async function readBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) throw new Error("Codex returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error("Codex image response exceeds the size limit.");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export default function codexImageExtension(pi: ExtensionAPI) {
  let enabled = false;
  let tuiActive = false;
  let uiGeneration = 0;

  function setEnabled(value: boolean) {
    enabled = value;
    const active = pi.getActiveTools().filter((name) => name !== TOOL);
    pi.setActiveTools(enabled ? [...active, TOOL] : active);
  }

  pi.on("session_start", (_event, ctx) => {
    setEnabled(false);
    tuiActive = ctx.mode === "tui";
    uiGeneration++;
  });
  pi.on("session_shutdown", () => {
    setEnabled(false);
    tuiActive = false;
    uiGeneration++;
  });

  pi.registerCommand("image", {
    description: "Enable the image generation tool for this session. Use /image off to disable it. Does not generate an image.",
    handler(args, ctx) {
      const action = args.trim();
      if (action && action !== "off") {
        ctx.ui.notify("Usage: /image to enable, /image off to disable. Request an image in the conversation afterward.", "warning");
        return;
      }
      setEnabled(action !== "off");
      ctx.ui.notify(enabled ? "Image tool enabled for this session." : "Image tool disabled.", "info");
    },
  });

  pi.registerTool(defineTool({
    name: TOOL,
    defaultActive: false,
    label: "Generate image (Codex subscription)",
    description: "Generate one PNG using the existing Codex subscription after /image enables this tool. Saves only in /tmp/ and returns the file path. Consumes Codex quota; no API-key fallback.",
    promptGuidelines: [
      "Use generate_image only when the user requests an image. Enabling the tool with /image is not itself a generation request.",
      "Compose a self-contained visual prompt from the relevant conversation; exclude credentials, unrelated private information, and raw conversation logs.",
      "Only the tool result is restricted to a file path, not your final response. Explain the outcome and continue the user's task as needed.",
      "The TUI already displays the generated file path and image preview. Do not repeat the path or add an image link in your final response unless the user asks.",
      "The local preview is not sent to the model. Do not call read on the image unless the user asks you to inspect it.",
      "Do not automatically retry a failed or timed-out generation: the request may already have consumed quota. Honor the requested model; do not silently switch models on failure.",
    ],
    parameters: Type.Object({
      model: Type.Optional(StringEnum([DEFAULT_OPTIONS.model, "gpt-image-2.5-sunburst"] as const, { description: "Image model for this call. Defaults to gpt-image-2.5-flare; select gpt-image-2.5-sunburst when requested." })),
      prompt: Type.String({ minLength: 1, maxLength: 32000, description: "Self-contained image description based on the conversation and user's image request." }),
      quality: Type.Optional(StringEnum(["low", "medium", "high", "auto"] as const, { description: "Requested quality; defaults to auto. The Codex backend may override it." })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!enabled) throw new Error("Image generation tool is disabled. Enable it with /image.");
      signal?.throwIfAborted();
      if (!params.prompt.trim()) throw new Error("An image prompt is required.");
      const imageModel = params.model ?? DEFAULT_OPTIONS.model;
      const model = ctx.modelRegistry.getAll().find((item) => item.provider === PROVIDER);
      if (!model || !ctx.modelRegistry.isUsingOAuth(model)) {
        throw new Error("A Codex subscription login is required. Run /login openai-codex; API keys are not used.");
      }
      const token = (await ctx.modelRegistry.getProviderAuth(PROVIDER))?.auth.apiKey;
      if (!token) throw new Error("Codex authentication could not be resolved. Run /login openai-codex.");
      let accountId: unknown;
      try {
        const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
        accountId = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
      } catch {
        throw new Error("Codex returned an invalid subscription token. Log in again.");
      }
      if (typeof accountId !== "string" || !accountId.trim()) {
        throw new Error("The Codex login token has no ChatGPT account ID.");
      }
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(300_000);
      const response = await fetch(ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: {
          Authorization: `Bearer ${token}`,
          "ChatGPT-Account-ID": accountId,
          "Content-Type": "application/json",
          "x-codex-image-turn-id": randomUUID(),
        },
        body: JSON.stringify({
          ...DEFAULT_OPTIONS,
          model: imageModel,
          prompt: params.prompt,
          quality: params.quality ?? DEFAULT_OPTIONS.quality,
        }),
      });
      const body = await readBody(response, response.ok ? 48 * 1024 * 1024 : 64 * 1024).catch((error) => {
        if (response.ok) throw error;
        return "";
      });
      let payload: any;
      try {
        payload = JSON.parse(body);
      } catch (error) {
        if (response.ok) throw error;
      }
      if (!response.ok) {
        const message = [payload?.error?.message, payload?.detail, payload?.message, body, response.statusText]
          .find((value) => typeof value === "string" && value.trim()) || "Unknown error";
        const requestId = response.headers.get("x-codex-imagegen-request-id") || response.headers.get("x-request-id") || response.headers.get("cf-ray");
        const detail = `model=${imageModel}${requestId ? `, request_id=${requestId}` : ""}: ${message}`;
        const safeMessage = detail.replaceAll(token, "[redacted]").replaceAll(accountId, "[redacted]").replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 1000);
        throw new Error(`Codex image generation failed (HTTP ${response.status}): ${safeMessage}. No retry or API-key fallback was made.`);
      }
      const encoded = payload?.data?.[0]?.b64_json;
      if (typeof encoded !== "string" || encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
        throw new Error("Codex did not return a valid, bounded base64 image. Do not automatically retry.");
      }
      const image = Buffer.from(encoded, "base64");
      if (image.length > MAX_IMAGE_BYTES || image.length < 24 || !image.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
        throw new Error("Codex did not return a valid PNG. Do not automatically retry.");
      }
      const directory = await mkdtemp("/tmp/pi-image-");
      const path = join(directory, "image.png");
      try {
        await writeFile(path, image, { flag: "wx", mode: 0o600 });
      } catch (error) {
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
      return {
        content: [{ type: "text", text: path }],
        details: { path, model: imageModel, provider: PROVIDER, bytes: image.length },
      };
    },
    renderCall(args, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const model = typeof args?.model === "string"
        ? args.model.replace(/[\x00-\x1f\x7f-\x9f]/g, "")
        : context.argsComplete ? DEFAULT_OPTIONS.model : "…";
      text.setText(`${theme.fg("toolTitle", theme.bold(TOOL))} ${theme.fg("muted", model)}`);
      return text;
    },
    renderResult(result, _options, theme, context) {
      const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      const path = result.details?.path;
      const output = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
      text.setText(!context.isError && path && getCapabilities().hyperlinks
        ? hyperlink(theme.fg("accent", theme.underline(path)), pathToFileURL(path).href)
        : output);
      if (!tuiActive || context.isError || context.isPartial || !path || !context.showImages || !getCapabilities().images) return text;

      const state = context.state as { preview?: ImagePreview };
      if (state.preview?.path !== path) {
        const preview: ImagePreview = { path };
        state.preview = preview;
        const generation = uiGeneration;
        void readPreview(path).then(
          (data) => { preview.data = data; },
          () => { preview.unavailable = true; },
        ).then(() => {
          if (tuiActive && generation === uiGeneration && state.preview === preview) context.invalidate();
        });
      }
      const preview = state.preview;
      const container = new Container();
      container.addChild(text);
      if (preview.data) {
        const width = pi.getSettings().terminal?.imageWidthCells ?? 60;
        if (!preview.image || preview.theme !== theme || preview.width !== width) {
          preview.image = new Image(preview.data, "image/png", { fallbackColor: (value) => theme.fg("muted", value) }, {
            filename: path,
            maxWidthCells: width,
            maxHeightCells: 24,
          });
          preview.theme = theme;
          preview.width = width;
        }
        container.addChild(new Spacer(1));
        container.addChild(preview.image);
      } else {
        container.addChild(new Text(theme.fg("dim", preview.unavailable ? "[Preview unavailable; open the path above]" : "[Loading preview…]"), 0, 0));
      }
      return container;
    },
  }));
}
