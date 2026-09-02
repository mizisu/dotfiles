import { parentPort, workerData } from "node:worker_threads";
import { createRuntime, loadServerDefinitions } from "mcporter";
import { clearOAuthCaches } from "./node_modules/mcporter/dist/oauth-persistence.js";

if (!parentPort) throw new Error("MCP runtime worker requires a parent port.");

const logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function serializeDefinition(definition) {
  if (definition.command.kind !== "http") return definition;
  return {
    ...definition,
    command: {
      ...definition.command,
      url: definition.command.url.toString(),
    },
  };
}

function deserializeDefinition(definition) {
  if (definition.command.kind !== "http") return definition;
  return {
    ...definition,
    command: {
      ...definition.command,
      url: new URL(definition.command.url),
    },
  };
}

async function startCatalogWorker() {
  const definitions = await loadServerDefinitions({ rootDir: workerData.rootDir });
  parentPort.postMessage({
    type: "ready",
    definitions: definitions.map(serializeDefinition),
  });
}

async function startServerWorker() {
  const definition = deserializeDefinition(workerData.definition);
  const runtime = await createRuntime({
    rootDir: workerData.rootDir,
    servers: [definition],
    logger,
    clientInfo: {
      name: "pi-mcporter",
      version: "0.1.0",
    },
  });

  let cancelling = false;
  parentPort.on("message", async (message) => {
    if (!message) return;
    if (message.type === "cancel") {
      if (cancelling) return;
      cancelling = true;
      await runtime.close().catch(() => undefined);
      parentPort.postMessage({ type: "cancelled" });
      return;
    }
    if (message.type !== "request" || cancelling) return;
    const { id, method, args = [] } = message;

    try {
      let result;
      if (method === "listTools") {
        result = await runtime.listTools(...args);
      } else if (method === "callTool") {
        result = await runtime.callTool(...args);
      } else if (method === "authorize") {
        const [server, reset] = args;
        await runtime.close(server).catch(() => undefined);
        if (reset) await clearOAuthCaches(runtime.getDefinition(server));
        result = await runtime.listTools(server, {
          includeSchema: true,
          autoAuthorize: true,
        });
      } else if (method === "close") {
        await runtime.close();
      } else {
        throw new Error(`Unsupported MCP worker method: ${method}`);
      }
      parentPort.postMessage({ type: "result", id, ok: true, result });
    } catch (error) {
      parentPort.postMessage({ type: "result", id, ok: false, error: errorMessage(error) });
    }
  });
  parentPort.postMessage({ type: "ready" });
}

try {
  if (workerData.mode === "catalog") await startCatalogWorker();
  else if (workerData.mode === "server") await startServerWorker();
  else throw new Error(`Unsupported MCP worker mode: ${workerData.mode}`);
} catch (error) {
  parentPort.postMessage({ type: "init-error", error: errorMessage(error) });
}
