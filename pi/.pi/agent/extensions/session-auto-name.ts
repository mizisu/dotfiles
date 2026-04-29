import { complete, type UserMessage } from "@mariozechner/pi-ai";
import {
  getAgentDir,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const STATUS_KEY = "session-auto-name";
const MAX_TITLE_LENGTH = 50;
const MAX_INPUT_CHARS = 4000;

const TITLE_SYSTEM_PROMPT = `You are a title generator. You output ONLY a thread title. Nothing else.

<task>
Generate a brief title that would help the user find this conversation later.

Follow all rules in <rules>
Use the <examples> so you know what a good title looks like.
Your output must be:
- A single line
- ≤50 characters
- No explanations
</task>

<rules>
- you MUST use the same language as the user message you are summarizing
- Title must be grammatically correct and read naturally - no word salad
- Never include tool names in the title (e.g. "read tool", "bash tool", "edit tool")
- Focus on the main topic or question the user needs to retrieve
- Vary your phrasing - avoid repetitive patterns like always starting with "Analyzing"
- When a file is mentioned, focus on WHAT the user wants to do WITH the file, not just that they shared it
- Keep exact: technical terms, numbers, filenames, HTTP codes
- Remove: the, this, my, a, an
- Never assume tech stack
- Never use tools
- NEVER respond to questions, just generate a title for the conversation
- The title should NEVER include "summarizing" or "generating" when generating a title
- DO NOT SAY YOU CANNOT GENERATE A TITLE OR COMPLAIN ABOUT THE INPUT
- Always output something meaningful, even if the input is minimal.
- If the user message is short or conversational (e.g. "hello", "lol", "what's up", "hey"):
  → create a title that reflects the user's tone or intent (such as Greeting, Quick check-in, Light chat, Intro message, etc.)
</rules>

<examples>
"debug 500 errors in production" → Debugging production 500 errors
"refactor user service" → Refactoring user service
"why is app.js failing" → app.js failure investigation
"implement rate limiting" → Rate limiting implementation
"how do I connect postgres to my API" → Postgres API connection
"best practices for React hooks" → React hooks best practices
"@src/auth.ts can you add refresh token support" → Auth refresh token support
"@utils/parser.ts this is broken" → Parser bug fix
"look at @config.json" → Config review
"@App.tsx add dark mode toggle" → Dark mode toggle in App
</examples>`;

type SmallModelSettings = {
  smallProvider?: unknown;
  smallModel?: unknown;
  small_model?: unknown;
};

type SmallModelRef = {
  provider: string;
  modelId: string;
};

function parseModelRef(value: unknown): SmallModelRef | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;

  return {
    provider: trimmed.slice(0, slash),
    modelId: trimmed.slice(slash + 1),
  };
}

function getSmallModelRef(ctx: ExtensionContext): SmallModelRef | undefined {
  const settingsManager = SettingsManager.create(ctx.cwd, getAgentDir());
  const globalSettings = settingsManager.getGlobalSettings() as SmallModelSettings;
  const projectSettings = settingsManager.getProjectSettings() as SmallModelSettings;

  const projectModelRef = parseModelRef(projectSettings.small_model);
  if (projectModelRef) return projectModelRef;

  const projectProvider = typeof projectSettings.smallProvider === "string" ? projectSettings.smallProvider : undefined;
  const projectModel = typeof projectSettings.smallModel === "string" ? projectSettings.smallModel : undefined;
  const globalProvider = typeof globalSettings.smallProvider === "string" ? globalSettings.smallProvider : undefined;
  const globalModel = typeof globalSettings.smallModel === "string" ? globalSettings.smallModel : undefined;

  const provider = projectProvider ?? globalProvider;
  const modelId = projectModel ?? globalModel;
  if (provider && modelId) return { provider, modelId };

  return parseModelRef(globalSettings.small_model);
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .filter((part): part is { type: "text"; text: string } => {
      return Boolean(
        part &&
          typeof part === "object" &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string",
      );
    })
    .map((part) => part.text)
    .join("\n");
}

function getOnlyRealUserMessageText(ctx: ExtensionContext): string | undefined {
  const userMessages: string[] = [];

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "user") continue;

    const text = extractText(entry.message.content).trim();
    if (!text) continue;

    userMessages.push(text);
    if (userMessages.length > 1) return undefined;
  }

  const [firstUserMessage] = userMessages;
  if (!firstUserMessage) return undefined;

  return firstUserMessage.length > MAX_INPUT_CHARS
    ? `${firstUserMessage.slice(0, MAX_INPUT_CHARS).trim()}…`
    : firstUserMessage;
}

function cleanTitle(raw: string): string | undefined {
  const firstLine = raw
    .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!firstLine) return undefined;

  const cleaned = firstLine
    .replace(/^(?:[-*]|#{1,6}|>)\s+/, "")
    .replace(/^title\s*:\s*/i, "")
    .replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!。]+$/g, "")
    .trim();

  if (!cleaned) return undefined;
  if (cleaned.length <= MAX_TITLE_LENGTH) return cleaned;

  const truncated = cleaned.slice(0, MAX_TITLE_LENGTH).trim();
  return truncated || undefined;
}

async function generateTitle(ctx: ExtensionContext, firstUserMessage: string, signal: AbortSignal): Promise<string | undefined> {
  const smallModel = getSmallModelRef(ctx);
  if (!smallModel) return undefined;

  const model = ctx.modelRegistry.find(smallModel.provider, smallModel.modelId);
  if (!model) return undefined;

  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) return undefined;

  const message: UserMessage = {
    role: "user",
    content: [
      {
        type: "text",
        text: `Generate a title for this conversation:\n\n${firstUserMessage}`,
      },
    ],
    timestamp: Date.now(),
  };

  const response = await complete(
    model,
    {
      systemPrompt: TITLE_SYSTEM_PROMPT,
      messages: [message],
    },
    {
      apiKey: auth.apiKey,
      headers: auth.headers,
      maxTokens: 64,
      temperature: 0.5,
      cacheRetention: "none",
      signal,
    },
  );

  const text = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");

  return cleanTitle(text);
}

function clearStatus(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.setStatus(STATUS_KEY, undefined);
  } catch {
    // The session may be shutting down while title generation is being aborted.
  }
}

function setStatus(ctx: ExtensionContext, text: string): void {
  if (!ctx.hasUI) return;
  try {
    ctx.ui.setStatus(STATUS_KEY, text);
  } catch {
    // Ignore stale UI contexts during shutdown/reload.
  }
}

export default function (pi: ExtensionAPI) {
  let namingInFlight = false;
  let abortController: AbortController | undefined;

  async function maybeGenerateSessionName(ctx: ExtensionContext): Promise<void> {
    if (namingInFlight) return;
    if (pi.getSessionName()) return;

    const firstUserMessage = getOnlyRealUserMessageText(ctx);
    if (!firstUserMessage) return;

    namingInFlight = true;
    abortController = new AbortController();
    setStatus(ctx, "naming session...");

    try {
      const title = await generateTitle(ctx, firstUserMessage, abortController.signal);
      if (!title) return;

      // Do not overwrite a name that was set while the small model was running.
      if (pi.getSessionName()) return;

      pi.setSessionName(title);
    } catch {
      // Automatic naming should never interrupt the user's main workflow.
    } finally {
      abortController = undefined;
      namingInFlight = false;
      clearStatus(ctx);
    }
  }

  pi.on("agent_end", (_event, ctx) => {
    void maybeGenerateSessionName(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    abortController?.abort();
    clearStatus(ctx);
  });
}
