import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  createBashToolDefinition,
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { createCommandWorking, type CommandWorking } from "./shared/command-working.js";

const TEMP_DIRECTORY_PREFIX = "pi-aws-";
const EXPLICIT_PROFILE_REQUIRED = "__pi_aws_explicit_profile_required__";
const COMMAND_TIMEOUT_MS = 120_000;
const COMMAND_MAX_BUFFER_BYTES = 1024 * 1024;
const AWS_STATUS_KEY = "aws";

const PROFILE_NAMES = ["dev", "prod"] as const;
type ProfileName = (typeof PROFILE_NAMES)[number];

type ProfileConfig = {
  name: ProfileName;
  sourceProfile: string;
  otpItem: string;
};

type SessionCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  expiresAt: number;
};

type AwsAction = ProfileName | "all" | "status" | "off";

const PROFILES: Record<ProfileName, ProfileConfig> = {
  dev: {
    name: "dev",
    sourceProfile: "default",
    otpItem: "AWS Dev",
  },
  prod: {
    name: "prod",
    sourceProfile: "prod",
    otpItem: "AWS Prod",
  },
};

const ACTIONS = ["dev", "prod", "all", "status", "off"] as const;
const FILE_TOOLS = new Set(["read", "write", "edit", "grep", "find", "ls"]);
const RAW_CREDENTIAL_ENV_KEYS = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
] as const;

class AwsExtensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwsExtensionError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isProfileName(value: string): value is ProfileName {
  return (PROFILE_NAMES as readonly string[]).includes(value);
}

function normalizeAction(value: string): AwsAction | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "both") return "all";
  return (ACTIONS as readonly string[]).includes(normalized) ? (normalized as AwsAction) : undefined;
}

function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error" = "info",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
  else console.log(message);
}

function safeValue(value: unknown, field: string): string {
  if (typeof value !== "string" || !value || /[\0\r\n]/.test(value)) {
    throw new AwsExtensionError(`AWS returned an invalid ${field}`);
  }
  return value;
}

function parseSessionCredentials(output: string): SessionCredentials {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new AwsExtensionError("AWS returned invalid JSON");
  }

  const root = isRecord(payload) ? payload : undefined;
  const rawCredentials = root && isRecord(root.Credentials) ? root.Credentials : undefined;
  if (!rawCredentials) throw new AwsExtensionError("AWS response did not contain Credentials");

  const accessKeyId = safeValue(rawCredentials.AccessKeyId, "AccessKeyId");
  const secretAccessKey = safeValue(rawCredentials.SecretAccessKey, "SecretAccessKey");
  const sessionToken = safeValue(rawCredentials.SessionToken, "SessionToken");
  const expiration = safeValue(rawCredentials.Expiration, "Expiration");
  const expiresAt = Date.parse(expiration);

  if (!Number.isFinite(expiresAt)) throw new AwsExtensionError("AWS returned an invalid Expiration");
  if (expiresAt <= Date.now()) throw new AwsExtensionError("AWS returned credentials that are already expired");

  return { accessKeyId, secretAccessKey, sessionToken, expiresAt };
}

function safeAwsFailureDetail(stderr: string): string | undefined {
  if (/MultiFactorAuthentication failed/i.test(stderr)) {
    return "MFA authentication failed; wait for a new OTP and verify the MFA device and source profile";
  }
  if (/security token included in the request is expired/i.test(stderr)) {
    return "the source profile credentials are expired";
  }
  if (/security token included in the request is invalid/i.test(stderr)) {
    return "the source profile credentials are invalid";
  }

  const serviceError = stderr.match(/An error occurred \(([A-Za-z0-9_.-]+)\)/);
  return serviceError?.[1] ? `AWS ${serviceError[1]}` : undefined;
}

function commandError(
  command: string,
  label: string,
  error: Error & { code?: string | number | null; killed?: boolean },
  stderr: string,
): Error {
  if (error.code === "ENOENT") return new AwsExtensionError(`${command} was not found`);
  if (error.killed) return new AwsExtensionError(`${label} timed out`);
  const code = typeof error.code === "number" ? ` (exit ${error.code})` : "";
  const detail = safeAwsFailureDetail(stderr);
  return new AwsExtensionError(`${label} failed${code}${detail ? `: ${detail}` : ""}`);
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  label: string,
): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        env,
        encoding: "utf8",
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: COMMAND_MAX_BUFFER_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(commandError(command, label, error, stderr));
          return;
        }
        resolveOutput(stdout);
      },
    );
  });
}

function sourceProfileEnvironment(baseEnvironment: NodeJS.ProcessEnv, profile: string): NodeJS.ProcessEnv {
  const env = {
    ...baseEnvironment,
    AWS_PROFILE: profile,
    AWS_PAGER: "",
    AWS_CLI_AUTO_PROMPT: "off",
  };

  for (const key of RAW_CREDENTIAL_ENV_KEYS) delete env[key];
  return env;
}

async function requestSessionCredentials(
  config: ProfileConfig,
  cwd: string,
  baseEnvironment: NodeJS.ProcessEnv,
): Promise<SessionCredentials> {
  const sourceEnvironment = sourceProfileEnvironment(baseEnvironment, config.sourceProfile);
  let serialOutput: string;
  try {
    serialOutput = await runCommand(
      "aws",
      ["configure", "get", "mfa_serial", "--profile", config.sourceProfile],
      cwd,
      sourceEnvironment,
      `Reading mfa_serial from AWS profile ${config.sourceProfile}`,
    );
  } catch (error) {
    if (error instanceof AwsExtensionError && error.message === "aws was not found") throw error;
    throw new AwsExtensionError(
      `AWS profile ${config.sourceProfile} does not define mfa_serial. Configure it locally outside Git.`,
    );
  }

  const serialNumber = serialOutput.trim();
  if (!serialNumber || /[\0\r\n]/.test(serialNumber)) {
    throw new AwsExtensionError(`AWS profile ${config.sourceProfile} does not define a valid mfa_serial`);
  }

  const otpOutput = await runCommand(
    "op",
    ["item", "get", config.otpItem, "--otp"],
    cwd,
    baseEnvironment,
    `Reading the ${config.name} OTP from 1Password`,
  );
  const tokenCode = otpOutput.trim();
  if (!/^\d{6}$/.test(tokenCode)) {
    throw new AwsExtensionError(`1Password returned an invalid OTP for ${config.name}`);
  }

  const awsOutput = await runCommand(
    "aws",
    [
      "sts",
      "get-session-token",
      "--profile",
      config.sourceProfile,
      "--serial-number",
      serialNumber,
      "--token-code",
      tokenCode,
      "--output",
      "json",
      "--color",
      "off",
      "--no-cli-pager",
      "--no-cli-auto-prompt",
    ],
    cwd,
    sourceEnvironment,
    `Creating the ${config.name} AWS session`,
  );

  return parseSessionCredentials(awsOutput);
}

function serializeCredentials(credentials: ReadonlyMap<ProfileName, SessionCredentials>): string {
  const sections: string[] = [];

  for (const name of PROFILE_NAMES) {
    const value = credentials.get(name);
    if (!value) continue;
    sections.push(
      `[${name}]`,
      `aws_access_key_id = ${value.accessKeyId}`,
      `aws_secret_access_key = ${value.secretAccessKey}`,
      `aws_session_token = ${value.sessionToken}`,
      "",
    );
  }

  return `${sections.join("\n").trimEnd()}\n`;
}

function formatExpiration(expiresAt: number): string {
  return new Date(expiresAt).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function formatRemaining(expiresAt: number): string {
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) return "expired";

  const totalMinutes = Math.max(1, Math.floor(remainingMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m remaining` : `${minutes}m remaining`;
}

function statusLines(
  credentials: ReadonlyMap<ProfileName, SessionCredentials>,
  activeProfile: ProfileName | undefined,
): string[] {
  const lines = PROFILE_NAMES.map((name) => {
    const value = credentials.get(name);
    if (!value) return `${name}: not loaded`;
    return `${name}: ${formatRemaining(value.expiresAt)} (expires ${formatExpiration(value.expiresAt)})`;
  });

  if (credentials.size === 0) lines.push("default: normal shell AWS configuration");
  else if (activeProfile) lines.push(`default: ${activeProfile}`);
  else lines.push("default: none; use --profile dev or --profile prod");

  return lines;
}

function commandUsesAwsCli(command: string): boolean {
  return /(?:^|[\s;&|()])(?:[^\s;&|()]*\/)?aws(?=$|[\s;&|()])/.test(command);
}

function explicitProfileFromCommand(command: string): { explicit: boolean; name?: string } {
  const option = command.match(/(?:^|\s)--profile(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
  if (option) return { explicit: true, name: option[1] ?? option[2] ?? option[3] };

  const assignment = command.match(/(?:^|\s)AWS_PROFILE=(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/);
  if (assignment) return { explicit: true, name: assignment[1] ?? assignment[2] ?? assignment[3] };

  return { explicit: false };
}

function pathInsideDirectory(candidate: string, cwd: string, directory: string | undefined): boolean {
  if (!directory) return false;
  const absolute = resolve(cwd, candidate.replace(/^@/, ""));
  return absolute === directory || absolute.startsWith(`${directory}${sep}`);
}

export default function awsExtension(pi: ExtensionAPI) {
  const baseEnvironment = { ...process.env };
  const baseBashTool = createBashToolDefinition(process.cwd());
  let credentials = new Map<ProfileName, SessionCredentials>();
  let activeProfile: ProfileName | undefined;
  let tempDirectory: string | undefined;
  let credentialsFile: string | undefined;
  let commandRunning = false;

  const ensureTempDirectory = async (): Promise<string> => {
    if (tempDirectory) return tempDirectory;

    try {
      const directory = await mkdtemp(join(tmpdir(), TEMP_DIRECTORY_PREFIX));
      await chmod(directory, 0o700);
      tempDirectory = directory;
      credentialsFile = join(directory, "credentials");
      return directory;
    } catch {
      throw new AwsExtensionError("Could not create the temporary AWS credential directory");
    }
  };

  const persistCredentials = async (nextCredentials: ReadonlyMap<ProfileName, SessionCredentials>): Promise<void> => {
    const directory = await ensureTempDirectory();
    const target = join(directory, "credentials");
    const temporary = join(directory, `.credentials-${randomUUID()}.tmp`);

    try {
      await writeFile(temporary, serializeCredentials(nextCredentials), {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      await rename(temporary, target);
      await chmod(target, 0o600);
      credentialsFile = target;
    } catch {
      await rm(temporary, { force: true }).catch(() => {});
      throw new AwsExtensionError("Could not store the temporary AWS credentials");
    }
  };

  const clearCredentials = async (): Promise<void> => {
    const directory = tempDirectory;
    credentials = new Map();
    activeProfile = undefined;
    tempDirectory = undefined;
    credentialsFile = undefined;
    if (directory) await rm(directory, { recursive: true, force: true }).catch(() => {});
  };

  const updateStatus = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const loaded = PROFILE_NAMES.filter((name) => credentials.has(name));
    const label = activeProfile
      ? `AWS: ${activeProfile}`
      : loaded.length > 0
        ? `AWS: ${loaded.join("+")}`
        : undefined;
    ctx.ui.setStatus(AWS_STATUS_KEY, label);
  };

  const refreshProfiles = async (
    names: readonly ProfileName[],
    ctx: ExtensionCommandContext,
    working: CommandWorking,
  ): Promise<void> => {
    const nextCredentials = new Map(credentials);

    for (const name of names) {
      const config = PROFILES[name];
      working.set(`Authenticating AWS ${name}`, [`source profile: ${config.sourceProfile}`]);
      nextCredentials.set(name, await requestSessionCredentials(config, ctx.cwd, baseEnvironment));
    }

    await persistCredentials(nextCredentials);
    credentials = nextCredentials;
    activeProfile = names.length === 1 ? names[0] : undefined;
    updateStatus(ctx);

    notify(
      ctx,
      [`AWS ${names.join(" and ")} ready.`, ...statusLines(credentials, activeProfile)].join("\n"),
    );
  };

  const runAction = async (action: AwsAction, ctx: ExtensionCommandContext): Promise<void> => {
    if (action === "status") {
      notify(ctx, statusLines(credentials, activeProfile).join("\n"));
      return;
    }

    if (commandRunning) {
      notify(ctx, "Another /aws command is already running", "warning");
      return;
    }

    commandRunning = true;
    const working = createCommandWorking(ctx, "aws-auth", "AWS authentication");

    try {
      await ctx.waitForIdle();

      if (action === "off") {
        working.set("Removing temporary AWS credentials");
        await clearCredentials();
        updateStatus(ctx);
        notify(ctx, "Temporary AWS credentials removed");
        return;
      }

      await refreshProfiles(action === "all" ? PROFILE_NAMES : [action], ctx, working);
    } catch (error) {
      const message = error instanceof AwsExtensionError
        ? error.message
        : "AWS authentication failed unexpectedly";
      notify(ctx, message, "error");
    } finally {
      working.clear();
      commandRunning = false;
    }
  };

  pi.registerCommand("aws", {
    description: "Load temporary AWS credentials. Usage: /aws [dev|prod|all|status|off]",
    getArgumentCompletions(prefix) {
      const query = prefix.trim().toLowerCase();
      if (query.includes(" ")) return null;
      const matches = ACTIONS
        .filter((action) => action.startsWith(query))
        .map((action) => ({ value: action, label: action }));
      return matches.length > 0 ? matches : null;
    },
    async handler(args, ctx) {
      const raw = (args ?? "").trim();
      let action = raw ? normalizeAction(raw) : undefined;

      if (!raw) {
        if (!ctx.hasUI) {
          notify(ctx, "Usage: /aws dev|prod|all|status|off", "error");
          return;
        }
        const selected = await ctx.ui.select("AWS credentials", [...ACTIONS]);
        if (!selected) return;
        action = normalizeAction(selected);
      }

      if (!action) {
        notify(ctx, "Usage: /aws dev|prod|all|status|off", "error");
        return;
      }

      await runAction(action, ctx);
    },
  });

  pi.registerTool({
    ...baseBashTool,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const bashTool = createBashToolDefinition(ctx.cwd, {
        spawnHook: ({ command, cwd, env }) => {
          if (!credentialsFile || credentials.size === 0) return { command, cwd, env };

          const nextEnvironment = { ...env };
          for (const key of RAW_CREDENTIAL_ENV_KEYS) delete nextEnvironment[key];
          nextEnvironment.AWS_SHARED_CREDENTIALS_FILE = credentialsFile;
          nextEnvironment.AWS_PROFILE = activeProfile ?? EXPLICIT_PROFILE_REQUIRED;
          nextEnvironment.AWS_PAGER = "";
          nextEnvironment.AWS_CLI_AUTO_PROMPT = "off";
          return { command, cwd, env: nextEnvironment };
        },
      });
      return bashTool.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (FILE_TOOLS.has(event.toolName)) {
      const input = isRecord(event.input) ? event.input : undefined;
      const candidate = input?.path;
      if (typeof candidate === "string" && pathInsideDirectory(candidate, ctx.cwd, tempDirectory)) {
        return { block: true, reason: "Access to Pi's temporary AWS credentials is blocked" };
      }
    }

    if (!isToolCallEventType("bash", event)) return undefined;
    const command = event.input.command;

    if (
      command.includes("AWS_SHARED_CREDENTIALS_FILE") ||
      command.includes(TEMP_DIRECTORY_PREFIX) ||
      (tempDirectory && command.includes(tempDirectory))
    ) {
      return { block: true, reason: "Access to Pi's temporary AWS credentials is blocked" };
    }

    if (credentials.size === 0 || !commandUsesAwsCli(command)) return undefined;

    const selected = explicitProfileFromCommand(command);
    if (!activeProfile && !selected.explicit) {
      return {
        block: true,
        reason: "Both AWS profiles are loaded. Specify --profile dev or --profile prod.",
      };
    }

    const target = selected.explicit ? selected.name : activeProfile;
    if (!target || !isProfileName(target)) return undefined;

    const value = credentials.get(target);
    if (!value) {
      return { block: true, reason: `AWS profile ${target} is not loaded. Ask the user to run /aws ${target}.` };
    }
    if (value.expiresAt <= Date.now()) {
      return { block: true, reason: `AWS profile ${target} has expired. Ask the user to run /aws ${target}.` };
    }

    return undefined;
  });

  pi.on("before_agent_start", async (event) => {
    if (credentials.size === 0) return undefined;

    const loaded = PROFILE_NAMES.filter((name) => credentials.has(name));
    const guidance = [
      "AWS CLI session state is managed by the /aws extension.",
      `Loaded temporary profiles: ${loaded.join(", ")}.`,
      activeProfile
        ? `AWS CLI commands without --profile use ${activeProfile}. Use --profile explicitly to select another loaded profile.`
        : "There is no default AWS profile. Every AWS CLI command must specify --profile dev or --profile prod.",
      ...loaded.map((name) => {
        const value = credentials.get(name)!;
        return `${name} expires at ${formatExpiration(value.expiresAt)}.`;
      }),
      "Never inspect, print, or read AWS credential files or credential environment values.",
    ];

    return { systemPrompt: `${event.systemPrompt}\n\n${guidance.join("\n")}` };
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await clearCredentials();
    if (ctx.hasUI) ctx.ui.setStatus(AWS_STATUS_KEY, undefined);
  });
}
