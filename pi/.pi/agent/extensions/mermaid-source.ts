// @ts-nocheck -- bridges private TUI state until expanded is exposed to Markdown transformers.
import {
  AssistantMessageComponent,
  type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Markdown, Marked } from "@earendil-works/pi-tui";

type SetExpanded = (expanded: boolean) => void;
type UpdateContent = (message: unknown, isStreaming?: boolean) => void;
type MarkdownTransform = (markdown: string, availableWidth: number) => string;

type MarkdownInternals = {
  text?: unknown;
  options?: { transform?: MarkdownTransform };
  invalidate?: () => void;
};

type AssistantInternals = {
  contentContainer?: { children?: unknown[] };
};

type PatchState = {
  originalSetExpandedDescriptor?: PropertyDescriptor;
  setExpandedGetter: (this: object) => SetExpanded | undefined;
  setExpandedWrapper: SetExpanded;
  originalUpdateContent: UpdateContent;
  updateContentWrapper: UpdateContent;
  hasMermaid: WeakMap<object, boolean>;
  assistantExpansion: WeakMap<object, boolean>;
  getToolsExpanded?: () => boolean;
  currentExpanded?: boolean;
  originalTransforms: Map<object, MarkdownTransform | undefined>;
  wrappedTransforms: Map<object, MarkdownTransform>;
};

const PATCH_STATE_KEY = Symbol.for("pi.mermaid-source.patch");
const MERMAID_FENCE_PATTERN = /^[ \t]{0,3}(?:`{3,}|~{3,})[^\S\r\n]*mermaid\b/im;
const parser = new Marked();

function assistantPrototype() {
  return AssistantMessageComponent.prototype as typeof AssistantMessageComponent.prototype & {
    updateContent: UpdateContent;
    [PATCH_STATE_KEY]?: PatchState;
  };
}

function markdownChildren(instance: object): object[] {
  const children = (instance as AssistantInternals).contentContainer?.children;
  if (!Array.isArray(children)) return [];
  return children.filter((child) => child instanceof Markdown) as object[];
}

function markdownText(instance: object): string {
  const text = (instance as MarkdownInternals).text;
  return typeof text === "string" ? text : "";
}

function assistantHasMermaid(instance: object): boolean {
  return markdownChildren(instance).some((child) => MERMAID_FENCE_PATTERN.test(markdownText(child)));
}

function mermaidSources(markdown: string): string[] {
  if (!MERMAID_FENCE_PATTERN.test(markdown)) return [];

  try {
    return parser
      .lexer(markdown)
      .filter((token) => {
        if (token.type !== "code") return false;
        const language = token.lang?.trim().split(/\s+/, 1)[0]?.toLowerCase();
        return language === "mermaid";
      })
      .map((token) => token.raw.trimEnd());
  } catch {
    return [];
  }
}

function restoreMarkdownTransform(instance: object, state: PatchState): void {
  const wrapper = state.wrappedTransforms.get(instance);
  if (!wrapper) return;

  const markdown = instance as MarkdownInternals;
  if (markdown.options?.transform === wrapper) {
    markdown.options.transform = state.originalTransforms.get(instance);
  }

  state.originalTransforms.delete(instance);
  state.wrappedTransforms.delete(instance);
  markdown.invalidate?.();
}

function setMarkdownExpanded(instance: object, expanded: boolean, state: PatchState): void {
  const markdown = instance as MarkdownInternals;
  const text = markdownText(instance);
  const options = markdown.options;

  if (!expanded || !options || !MERMAID_FENCE_PATTERN.test(text)) {
    restoreMarkdownTransform(instance, state);
    return;
  }

  if (state.wrappedTransforms.has(instance)) return;

  const originalTransform = options.transform;
  const wrapper: MarkdownTransform = (source, availableWidth) => {
    const transformed = originalTransform?.(source, availableWidth) ?? source;
    const sources = mermaidSources(source);

    // If the built-in renderer left a Mermaid fence intact, it already serves as source.
    if (sources.length === 0 || MERMAID_FENCE_PATTERN.test(transformed)) return transformed;

    return `${transformed.trimEnd()}\n\n${sources.join("\n\n")}`;
  };

  state.originalTransforms.set(instance, originalTransform);
  state.wrappedTransforms.set(instance, wrapper);
  options.transform = wrapper;
  markdown.invalidate?.();
}

function applyAssistantExpansion(instance: object, expanded: boolean, state: PatchState): void {
  for (const child of markdownChildren(instance)) {
    setMarkdownExpanded(child, expanded, state);
  }
}

function restoreAssistantTransforms(instance: object, state: PatchState): void {
  for (const child of markdownChildren(instance)) {
    restoreMarkdownTransform(child, state);
  }
}

function originalSetExpanded(instance: object, state: PatchState): SetExpanded | undefined {
  const descriptor = state.originalSetExpandedDescriptor;
  if (!descriptor) return undefined;
  if (typeof descriptor.value === "function") return descriptor.value;
  const value = descriptor.get?.call(instance);
  return typeof value === "function" ? value : undefined;
}

function installPatch(): PatchState {
  const assistant = assistantPrototype();
  const existing = assistant[PATCH_STATE_KEY];
  if (existing) return existing;

  const state: PatchState = {
    originalSetExpandedDescriptor: Object.getOwnPropertyDescriptor(assistant, "setExpanded"),
    setExpandedGetter: function (this: object) {
      if (state.hasMermaid.get(this)) return state.setExpandedWrapper;
      return originalSetExpanded(this, state);
    },
    setExpandedWrapper: function (this: object, expanded: boolean) {
      state.currentExpanded = expanded;
      state.assistantExpansion.set(this, expanded);
      originalSetExpanded(this, state)?.call(this, expanded);
      applyAssistantExpansion(this, expanded, state);
    },
    originalUpdateContent: assistant.updateContent,
    updateContentWrapper: function (this: object, message: unknown, isStreaming?: boolean) {
      restoreAssistantTransforms(this, state);
      state.originalUpdateContent.call(this, message, isStreaming);

      const hasMermaid = assistantHasMermaid(this);
      state.hasMermaid.set(this, hasMermaid);
      if (!hasMermaid) return;

      const expanded = state.assistantExpansion.get(this)
        ?? state.getToolsExpanded?.()
        ?? state.currentExpanded;
      if (expanded !== undefined) applyAssistantExpansion(this, expanded, state);
    },
    hasMermaid: new WeakMap<object, boolean>(),
    assistantExpansion: new WeakMap<object, boolean>(),
    originalTransforms: new Map<object, MarkdownTransform | undefined>(),
    wrappedTransforms: new Map<object, MarkdownTransform>(),
  };

  assistant[PATCH_STATE_KEY] = state;
  Object.defineProperty(assistant, "setExpanded", {
    configurable: true,
    enumerable: state.originalSetExpandedDescriptor?.enumerable ?? false,
    get: state.setExpandedGetter,
  });
  assistant.updateContent = state.updateContentWrapper;
  return state;
}

function uninstallPatch(): void {
  const assistant = assistantPrototype();
  const state = assistant[PATCH_STATE_KEY];
  if (!state) return;

  for (const instance of state.wrappedTransforms.keys()) {
    restoreMarkdownTransform(instance, state);
  }

  const descriptor = Object.getOwnPropertyDescriptor(assistant, "setExpanded");
  if (descriptor?.get === state.setExpandedGetter) {
    if (state.originalSetExpandedDescriptor) {
      Object.defineProperty(assistant, "setExpanded", state.originalSetExpandedDescriptor);
    } else {
      delete assistant.setExpanded;
    }
  }
  if (assistant.updateContent === state.updateContentWrapper) {
    assistant.updateContent = state.originalUpdateContent;
  }

  delete assistant[PATCH_STATE_KEY];
}

export default function mermaidSourceExtension(pi: ExtensionAPI) {
  const state = installPatch();

  pi.on("session_start", (_event, ctx) => {
    state.getToolsExpanded = () => ctx.ui.getToolsExpanded();
  });

  pi.on("session_shutdown", () => {
    state.getToolsExpanded = undefined;
    uninstallPatch();
  });
}
