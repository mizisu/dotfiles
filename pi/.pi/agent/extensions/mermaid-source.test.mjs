import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const extensionPath = fileURLToPath(new URL("./mermaid-source.ts", import.meta.url));

async function loadExtensionHarness() {
  const globalNodeModules = execFileSync("npm", ["root", "--global"], {
    encoding: "utf8",
  }).trim();
  const codingAgentRoot = join(
    globalNodeModules,
    "@earendil-works",
    "pi-coding-agent",
  );
  const tuiRoot = join(
    codingAgentRoot,
    "node_modules",
    "@earendil-works",
    "pi-tui",
  );
  const harnessRoot = await mkdtemp(join(tmpdir(), "mermaid-source-test-"));
  const packageScope = join(harnessRoot, "node_modules", "@earendil-works");
  const copiedExtension = join(harnessRoot, "mermaid-source.ts");

  await mkdir(packageScope, { recursive: true });
  await Promise.all([
    symlink(codingAgentRoot, join(packageScope, "pi-coding-agent"), "dir"),
    symlink(tuiRoot, join(packageScope, "pi-tui"), "dir"),
    copyFile(extensionPath, copiedExtension),
  ]);

  const [{ default: installExtension }, codingAgent, mermaid] = await Promise.all([
    import(pathToFileURL(copiedExtension).href),
    import(pathToFileURL(join(codingAgentRoot, "dist", "index.js")).href),
    import(
      pathToFileURL(
        join(
          codingAgentRoot,
          "dist",
          "modes",
          "interactive",
          "components",
          "mermaid.js",
        ),
      ).href
    ),
  ]);

  return {
    ...codingAgent,
    ...mermaid,
    installExtension,
    cleanup: () => rm(harnessRoot, { recursive: true, force: true }),
  };
}

test("expanded Mermaid source stays directly below its diagram", async () => {
  const harness = await loadExtensionHarness();
  const handlers = new Map();

  try {
    harness.installExtension({
      on(event, handler) {
        handlers.set(event, handler);
      },
    });
    await handlers.get("session_start")?.({}, {
      mode: "tui",
      ui: {
        getToolsExpanded: () => true,
        notify: () => undefined,
      },
    });

    const transformAssistantMarkdown = (source, availableWidth = 160) => {
      const component = new harness.AssistantMessageComponent(
        {
          role: "assistant",
          content: [{ type: "text", text: source }],
          stopReason: "stop",
        },
        false,
        undefined,
        undefined,
        1,
        [
          harness.createMermaidMarkdownTransformer({
            getMode: () => "final",
          }),
        ],
      );
      const markdown = component.contentContainer.children.find(
        (child) => typeof child?.options?.transform === "function",
      );
      assert.ok(markdown, "assistant Markdown child was not created");
      return markdown.options.transform(markdown.text, availableWidth);
    };

    const source = [
      "```mermaid",
      "graph LR",
      "  A --> B",
      "```",
      "",
      "AFTER_MARKER",
    ].join("\n");
    const transformed = transformAssistantMarkdown(source);
    const diagramIndex = transformed.indexOf("┌");
    const sourceIndex = transformed.indexOf("```mermaid");
    const followingParagraphIndex = transformed.indexOf("AFTER_MARKER");

    assert.notEqual(diagramIndex, -1, "Mermaid diagram was not rendered");
    assert.notEqual(sourceIndex, -1, "expanded Mermaid source is missing");
    assert.notEqual(
      followingParagraphIndex,
      -1,
      "paragraph following Mermaid diagram is missing",
    );
    assert.ok(
      diagramIndex < sourceIndex && sourceIndex < followingParagraphIndex,
      `expected diagram, source, then following paragraph:\n${transformed}`,
    );

    const originalScenario = [
      "BEFORE_MARKER",
      "",
      "```mermaid",
      "graph LR",
      "  A --> B",
      "```",
      "",
      "AFTER_MARKER",
    ].join("\n");
    const originalTransformed = transformAssistantMarkdown(originalScenario);
    assert.ok(
      originalTransformed.indexOf("BEFORE_MARKER") <
        originalTransformed.indexOf("┌") &&
        originalTransformed.indexOf("┌") <
          originalTransformed.indexOf("```mermaid") &&
        originalTransformed.indexOf("```mermaid") <
          originalTransformed.indexOf("AFTER_MARKER"),
      `expected original scenario order to be preserved:\n${originalTransformed}`,
    );

    const multipleDiagrams = [
      "```mermaid",
      "graph LR",
      "  A --> B",
      "```",
      "",
      "BETWEEN_MARKER",
      "",
      "```mermaid",
      "graph LR",
      "  C --> D",
      "```",
      "",
      "AFTER_MARKER",
    ].join("\n");
    const multipleTransformed = transformAssistantMarkdown(multipleDiagrams);
    assert.ok(
      multipleTransformed.indexOf("```mermaid\ngraph LR\n  A --> B") <
        multipleTransformed.indexOf("BETWEEN_MARKER") &&
        multipleTransformed.indexOf("BETWEEN_MARKER") <
          multipleTransformed.indexOf("```mermaid\ngraph LR\n  C --> D") &&
        multipleTransformed.indexOf("```mermaid\ngraph LR\n  C --> D") <
          multipleTransformed.indexOf("AFTER_MARKER"),
      `expected each source below its own diagram:\n${multipleTransformed}`,
    );

    const narrowTransformed = transformAssistantMarkdown(source, 1);
    assert.equal(
      narrowTransformed.match(/```mermaid/g)?.length,
      1,
      "an unrendered Mermaid fence should not be duplicated",
    );
  } finally {
    await handlers.get("session_shutdown")?.();
    await harness.cleanup();
  }
});

test("Mermaid patch follows TUI expansion, streaming, and shutdown lifecycle", async () => {
  const harness = await loadExtensionHarness();
  const handlers = new Map();
  const prototype = harness.AssistantMessageComponent.prototype;
  const originalSetExpanded = Object.getOwnPropertyDescriptor(
    prototype,
    "setExpanded",
  );
  const originalUpdateContent = prototype.updateContent;

  const message = (text) => ({
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
  });
  const createAssistant = (text) =>
    new harness.AssistantMessageComponent(
      message(text),
      false,
      undefined,
      undefined,
      1,
      [
        harness.createMermaidMarkdownTransformer({
          getMode: () => "final",
        }),
      ],
    );
  const transformAssistant = (component, availableWidth = 160) => {
    const markdown = component.contentContainer.children.find(
      (child) => typeof child?.options?.transform === "function",
    );
    assert.ok(markdown, "assistant Markdown child was not created");
    return markdown.options.transform(markdown.text, availableWidth);
  };

  try {
    harness.installExtension({
      on(event, handler) {
        handlers.set(event, handler);
      },
    });

    await handlers.get("session_start")?.({}, {
      mode: "rpc",
      ui: {
        getToolsExpanded: () => true,
        notify: () => undefined,
      },
    });
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(prototype, "setExpanded"),
      originalSetExpanded,
      "RPC mode must not patch TUI prototypes",
    );

    await handlers.get("session_start")?.({}, {
      mode: "tui",
      ui: {
        getToolsExpanded: () => true,
        notify: () => undefined,
      },
    });

    const firstSource = [
      "FIRST_BEFORE",
      "",
      "```mermaid",
      "graph LR",
      "  A --> B",
      "```",
      "",
      "FIRST_AFTER",
    ].join("\n");
    const secondSource = [
      "```mermaid",
      "graph TD",
      "  C --> D",
      "```",
      "",
      "SECOND_AFTER",
    ].join("\n");
    const first = createAssistant(firstSource);
    const second = createAssistant(secondSource);

    first.setExpanded(false);
    assert.equal(
      transformAssistant(first).includes("```mermaid"),
      false,
      "collapsed assistant should show only the rendered diagram",
    );

    first.setExpanded(true);
    first.setExpanded(true);
    const firstExpanded = transformAssistant(first);
    assert.equal(
      firstExpanded.match(/```mermaid/g)?.length,
      1,
      "repeated expansion must not duplicate source",
    );

    second.setExpanded(false);
    assert.equal(
      transformAssistant(second).includes("```mermaid"),
      false,
      "assistant expansion state must be independent",
    );
    assert.equal(
      transformAssistant(first).includes("```mermaid"),
      true,
      "collapsing another assistant must not collapse the first",
    );

    const streamedSource = [
      "STREAM_BEFORE",
      "",
      "```mermaid",
      "sequenceDiagram",
      "  A->>B: hello",
      "```",
      "",
      "STREAM_AFTER",
    ].join("\n");
    first.updateContent(message(streamedSource), true);
    const streamed = transformAssistant(first);
    assert.ok(streamed.includes("```mermaid\nsequenceDiagram"));
    assert.ok(streamed.indexOf("STREAM_BEFORE") < streamed.indexOf("```mermaid"));
    assert.ok(streamed.indexOf("```mermaid") < streamed.indexOf("STREAM_AFTER"));

    const plain = createAssistant("PLAIN_MARKDOWN_ONLY");
    assert.equal(typeof plain.setExpanded, "undefined");
    assert.ok(transformAssistant(plain).includes("PLAIN_MARKDOWN_ONLY"));

    await handlers.get("session_shutdown")?.();
    assert.deepEqual(
      Object.getOwnPropertyDescriptor(prototype, "setExpanded"),
      originalSetExpanded,
      "shutdown must restore the setExpanded descriptor",
    );
    assert.equal(
      prototype.updateContent,
      originalUpdateContent,
      "shutdown must restore updateContent",
    );

    await handlers.get("session_start")?.({}, {
      mode: "tui",
      ui: {
        getToolsExpanded: () => true,
        notify: () => undefined,
      },
    });
    assert.ok(
      transformAssistant(createAssistant(firstSource)).includes("```mermaid"),
      "patch must reinstall after a new TUI session",
    );
  } finally {
    await handlers.get("session_shutdown")?.();
    await harness.cleanup();
  }
});
