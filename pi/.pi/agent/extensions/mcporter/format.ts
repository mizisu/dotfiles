import { createCallResult } from "mcporter";
import type { CachedToolInfo } from "./cache.js";

const MAX_OUTPUT_CHARS = 20_000;
const MAX_OUTPUT_LINES = 400;

export interface ToolSelector {
  serverName: string;
  toolName: string;
}

export function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

export function truncateForModel(text: string): string {
  const lines = text.split(/\r\n|\r|\n/);
  let truncated = false;
  let content = text;

  if (lines.length > MAX_OUTPUT_LINES) {
    content = lines.slice(0, MAX_OUTPUT_LINES).join("\n");
    truncated = true;
  }

  if (content.length > MAX_OUTPUT_CHARS) {
    content = content.slice(0, MAX_OUTPUT_CHARS);
    truncated = true;
  }

  return truncated ? `${content}\n\n[Output truncated]` : content;
}

export function renderCallResult(raw: unknown): string {
  const result = createCallResult(raw);
  const markdown = result.markdown();
  if (markdown) return truncateForModel(markdown);

  const text = result.text();
  if (text) return truncateForModel(text);

  const json = result.json();
  if (json !== null) return truncateForModel(formatJson(json));

  return truncateForModel(formatJson(raw));
}

function schemaTypeLabel(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "unknown";
  const typeValue = (schema as { type?: unknown }).type;
  if (typeof typeValue === "string") return typeValue;
  if (Array.isArray(typeValue)) return typeValue.filter((item): item is string => typeof item === "string").join(" | ") || "unknown";
  if (Array.isArray((schema as { anyOf?: unknown[] }).anyOf)) return "anyOf";
  if (Array.isArray((schema as { oneOf?: unknown[] }).oneOf)) return "oneOf";
  return "unknown";
}

function describeParameters(schema: unknown): Array<{ name: string; required: boolean; type: string; description?: string; defaultValue?: unknown }> {
  if (!schema || typeof schema !== "object") return [];
  const objectSchema = schema as {
    properties?: Record<string, { type?: unknown; description?: unknown; default?: unknown }>;
    required?: unknown;
  };
  const required = Array.isArray(objectSchema.required)
    ? new Set(objectSchema.required.filter((item): item is string => typeof item === "string"))
    : new Set<string>();
  const properties = objectSchema.properties ?? {};
  const orderedKeys = [
    ...required,
    ...Object.keys(properties).filter((key) => !required.has(key)),
  ];

  return orderedKeys.map((name) => {
    const property = properties[name] ?? {};
    return {
      name,
      required: required.has(name),
      type: schemaTypeLabel(property),
      description: typeof property.description === "string" ? property.description : undefined,
      defaultValue: property.default,
    };
  });
}

export function renderToolSignature(selector: ToolSelector, tool: CachedToolInfo): string {
  const params = describeParameters(tool.inputSchema)
    .map((param) => `${param.name}${param.required ? "" : "?"}: ${param.type}`)
    .join(", ");
  return `${selector.serverName}.${selector.toolName}(${params})`;
}

export function renderToolDescription(selector: ToolSelector, tool: CachedToolInfo): string {
  const lines = [renderToolSignature(selector, tool)];
  if (tool.description) lines.push("", tool.description);

  const params = describeParameters(tool.inputSchema);
  if (params.length === 0) {
    lines.push("", "Parameters: none");
  } else {
    lines.push("", "Parameters:");
    for (const param of params) {
      let line = `- ${param.name}${param.required ? "" : "?"}: ${param.type}`;
      if (param.description) line += ` - ${param.description}`;
      if (param.defaultValue !== undefined) line += ` (default: ${JSON.stringify(param.defaultValue)})`;
      lines.push(line);
    }
  }

  if (tool.inputSchema && params.length === 0) {
    lines.push("", "Input schema:", formatJson(tool.inputSchema));
  }

  return truncateForModel(lines.join("\n"));
}

export function renderToolList(serverName: string, tools: CachedToolInfo[]): string {
  if (tools.length === 0) return `${serverName}: no tools found.`;

  const lines = [`${serverName} (${tools.length} tools):`, ""];
  for (const tool of [...tools].sort((a, b) => a.name.localeCompare(b.name))) {
    const summary = tool.description ? ` - ${tool.description}` : "";
    lines.push(`- ${tool.name}${summary}`);
  }
  lines.push("", `Use mcp({ describe: "${serverName}.${tools[0].name}" }) for parameters.`);
  return truncateForModel(lines.join("\n"));
}
