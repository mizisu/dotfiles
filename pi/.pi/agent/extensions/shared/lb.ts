import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { rexBlocks, rexCall, type RexBlock } from "./rex.js";

const PRIMARY = join(homedir(), "Desktop/src/lemonbase");
const SESSION_LABEL = "lb";
const ROLES = ["be", "fe"] as const;
type Role = typeof ROLES[number];
type Target = { root: string; id: string; windowLabel: string; legacyLabel: string };
type Config = { domain: string; be: number; fe: number; worktrunk: boolean };
type Session = { session_id: string; label: string };
type Program = {
  child?: { pid: number } | null;
  foreground?: { pid: number } | null;
  last_exit: { exit_code: number; error?: string } | null;
};
type ManagedBlock = RexBlock & { targetId: string; role: Role; port: number; program: Program };
type Probe = {
  role: Role;
  port?: number;
  block?: ManagedBlock;
  listeners: number[];
  state: "stopped" | "starting" | "running" | "exited" | "conflict" | "unknown";
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function envFile(path: string): Record<string, string> {
  try { return parseEnv(readFileSync(path, "utf8")); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return {};
    throw new Error(`${path} 파일을 읽을 수 없습니다.`);
  }
}

function domainFrom(env: Record<string, string>): string {
  const domain = env.DOMAIN || env.WORKTRUNK_DOMAIN;
  if (!domain) throw new Error("worktree 루트 .env에 DOMAIN을 설정해 주세요.");
  if (!/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)*[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?(?::\d{1,5})?$/i.test(domain)) {
    throw new Error(".env의 DOMAIN은 경로 없는 호스트 이름이어야 합니다.");
  }
  new URL(`https://${domain}`);
  return domain;
}

function portFrom(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const port = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} 값은 1~65535 사이의 포트여야 합니다.`);
  }
  return port;
}

function configFor(root: string): Config {
  const env = envFile(join(root, ".env"));
  const app = envFile(join(root, "app/.env"));
  const domain = domainFrom(env);
  if (env.WORKTRUNK_DOMAIN && env.WORKTRUNK_DOMAIN !== domain) {
    throw new Error("DOMAIN과 WORKTRUNK_DOMAIN이 다릅니다. 같은 worktree 도메인으로 맞춰 주세요.");
  }
  const be = portFrom(env.WORKTRUNK_API_PORT || env.API_PORT, 7777, "BE 포트");
  const fe = portFrom(env.WORKTRUNK_FRONTEND_PORT || app.FRONTEND_DEV_PORT, 8088, "FE 포트");
  if (be === fe) throw new Error("BE와 FE는 서로 다른 포트가 필요합니다.");
  return { domain, be, fe, worktrunk: Boolean(env.WORKTRUNK_DOMAIN) };
}

function sessions(): Session[] {
  return rexCall<{ sessions: Session[] | null }>("session.list").sessions ?? [];
}

function findSession(target: Target): Session | undefined {
  const all = sessions();
  const shared = all.filter((session) => session.label === SESSION_LABEL);
  if (shared.length > 1) throw new Error(`같은 이름의 Rex 세션이 여러 개입니다: ${SESSION_LABEL}`);
  const ownsBlocks = (session: Session) => rexBlocks(session.session_id)
    .some((block) => block.label?.startsWith(`lb:${target.id}:`));
  // Keep old per-worktree sessions manageable until an explicit restart migrates them.
  const legacy = all.filter((session) => session.label === target.legacyLabel && ownsBlocks(session));
  if (legacy.length > 1 || (legacy.length && shared[0] && ownsBlocks(shared[0]))) {
    throw new Error("이 worktree의 관리 블록이 여러 Rex 세션에 있습니다. Rex에서 확인해 주세요.");
  }
  return legacy[0] ?? shared[0];
}

function program(session: string, block: string): Program {
  return rexCall<Program>("com.superlogical.terminal.process", session, { block_id: block, args: {} });
}

function managedBlocks(session: string, id?: string): ManagedBlock[] {
  return rexBlocks(session).flatMap((block) => {
    const match = /^lb:([a-f0-9]{12}):(be|fe):(\d+)$/.exec(block.label ?? "");
    if (!match || (id && match[1] !== id)) return [];
    const role = match[2];
    if (role !== "be" && role !== "fe") return [];
    return [{ ...block, targetId: match[1]!, role, port: Number(match[3]), program: program(session, block.block_id) }];
  });
}

function belongsTo(pid: number, parent: number | undefined, parents: Map<number, number>): boolean {
  const visited = new Set<number>();
  while (pid > 0 && !visited.has(pid)) {
    if (pid === parent) return true;
    visited.add(pid);
    pid = parents.get(pid) ?? 0;
  }
  return false;
}

function layout(target: Target, config: Config, role: Role) {
  const environment = config.worktrunk ? [`WORKTRUNK_DOMAIN=${config.domain}`] : [];
  const command = role === "be"
    ? ["env", "-u", "NVIM", ...environment, `API_PORT=${config.be}`, "uv", "run", "manage.py", "runserver",
      `127.0.0.1:${config.be}`, "--settings=server.settings.local", "--skip-checks"]
    : ["env", "-u", "NVIM", ...environment,
      ...(config.worktrunk ? [`FRONTEND_PORT=${config.fe}`, `API_HOST=${config.domain}`,
        `FRONTEND_DEV_DOMAIN=${config.domain}`, `FRONTEND_DEV_PORT=${config.fe}`] : []),
      "pnpm", "start", "--port", String(config.fe), "--strictPort"];
  return { block: {
    flavor: "com.superlogical.terminal.shell",
    label: `lb:${target.id}:${role}:${config[role]}`,
    options: { cwd: role === "be" ? target.root : join(target.root, "app"), command, exit: { on_completion: false } },
  } };
}

function devLayout(target: Target, config: Config) {
  return { split: { direction: "horizontal", ratio: 0.5,
    before: layout(target, config, "be"), after: layout(target, config, "fe") } };
}

export class LbManager {
  constructor(private readonly exec: ExtensionAPI["exec"]) {}

  private async run(command: string, args: string[], cwd = PRIMARY, timeout = 5_000): Promise<string> {
    const result = await this.exec(command, args, { cwd, timeout, maxBuffer: 128 * 1024 });
    if (result.code !== 0 || result.killed || result.truncated) {
      throw new Error(`${command}: ${(result.stderr || result.stdout || "명령 실행 실패").trim().slice(-2000)}`);
    }
    return result.stdout.trim();
  }

  private async targetFor(path: string): Promise<Target> {
    const root = realpathSync(path);
    const id = createHash("sha256").update(root).digest("hex").slice(0, 12);
    const name = basename(root);
    const branch = await this.run("git", ["branch", "--show-current"], root);
    const windowLabel = [...(branch || name).replace(/\p{Cc}/gu, "-").trim()].slice(0, 128).join("");
    const legacyLabel = `lb:${name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 90)}:${id}`;
    return { root, id, windowLabel, legacyLabel };
  }

  async target(ctx: ExtensionContext): Promise<Target | undefined> {
    const commonArgs = ["rev-parse", "--path-format=absolute", "--git-common-dir"];
    const primaryCommon = realpathSync(await this.run("git", commonArgs));
    const current = await this.exec("git", commonArgs, { cwd: ctx.cwd, timeout: 5_000 });
    if (current.code === 0 && realpathSync(current.stdout.trim()) === primaryCommon) {
      return this.targetFor(await this.run("git", ["rev-parse", "--show-toplevel"], ctx.cwd));
    }
    if (!ctx.hasUI) throw new Error("lemonbase 또는 연결된 worktree에서 /lb를 실행해 주세요.");
    const output = await this.run("git", ["worktree", "list", "--porcelain", "-z"]);
    const paths = output.split("\0").filter((field) => field.startsWith("worktree "))
      .map((field) => field.slice(9)).filter((path) => existsSync(path));
    const selected = await ctx.ui.select("lb: worktree 선택", paths);
    return selected ? this.targetFor(selected) : undefined;
  }

  async open(target: Target): Promise<string> {
    const url = `https://${domainFrom(envFile(join(target.root, ".env")))}`;
    await this.run("open", [url], target.root);
    return url;
  }

  private async localRex(): Promise<void> {
    const identity: { endpoint?: string } = JSON.parse(await this.run("rex", ["--autostart=false", "whoami", "--json"]));
    if (!identity.endpoint?.startsWith("unix://")) throw new Error("/lb는 로컬 Rex 서버에서만 사용할 수 있습니다.");
  }

  private async locked<T>(action: () => Promise<T>): Promise<T> {
    await this.localRex();
    const parent = join(homedir(), ".cache/pi");
    const lock = join(parent, "lb.lock");
    mkdirSync(parent, { recursive: true });
    try { mkdirSync(lock, { mode: 0o700 }); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
        throw new Error(`다른 /lb 작업이 진행 중입니다. 비정상 종료된 작업이라면 ${lock}의 owner 파일을 확인하고 잠금을 제거해 주세요.`);
      }
      throw error;
    }
    try {
      writeFileSync(join(lock, "owner"), `pid=${process.pid}\nstarted=${new Date().toISOString()}\n`, { mode: 0o600 });
      return await action();
    } finally { rmSync(lock, { recursive: true, force: true }); }
  }

  private async listeners(port: number): Promise<number[]> {
    const result = await this.exec("lsof", ["-nP", "-a", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { timeout: 5_000 });
    if (result.killed || result.truncated || (result.code !== 0 && !(result.code === 1 && !result.stderr && !result.stdout))) {
      throw new Error(`포트 ${port} 조회 실패: ${result.stderr || "lsof를 실행할 수 없습니다."}`);
    }
    return [...new Set(result.stdout.split(/\s+/).filter(Boolean).map(Number))];
  }

  private async inspect(target: Target, session?: Session, config?: Config): Promise<Probe[]> {
    const blocks = session ? managedBlocks(session.session_id, target.id) : [];
    const entries = await Promise.all(ROLES.map(async (role) => {
      const matches = blocks.filter((block) => block.role === role);
      if (matches.length > 1) throw new Error(`${role.toUpperCase()} 관리 블록이 중복되어 있습니다. Rex에서 확인해 주세요.`);
      const block = matches[0];
      const port = block?.port ?? config?.[role];
      return { role, block, port, listeners: port ? await this.listeners(port) : [] };
    }));
    const parents = new Map<number, number>();
    const processes = await this.run("ps", ["-axo", "pid=,ppid="]);
    for (const line of processes.split("\n")) {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid && ppid !== undefined) parents.set(pid, ppid);
    }
    return entries.map((entry): Probe => {
      const info = entry.block?.program;
      const foreign = entry.listeners.some((pid) => !belongsTo(pid, info?.child?.pid, parents));
      const state = foreign ? "conflict" : !info ? "stopped" : info.last_exit ? "exited"
        : !info.child ? "unknown" : entry.listeners.length ? "running" : "starting";
      return { ...entry, state };
    });
  }

  async status(target: Target): Promise<string> {
    await this.localRex();
    let config: Config | undefined;
    let warning = "";
    try { config = configFor(target.root); }
    catch (error) { warning = errorMessage(error); }
    const session = findSession(target);
    const probes = await this.inspect(target, session, config);
    const lines = [target.root, config ? `https://${config.domain}` : `설정: ${warning}`,
      `Rex: ${session?.label ?? "세션 없음"}${session?.label === SESSION_LABEL ? ` / ${target.windowLabel}` : ""}`];
    if (session && session.label !== SESSION_LABEL) lines.push("공통 lb 세션으로 이동: /lb restart");
    for (const probe of probes) {
      const info = probe.block?.program;
      const details = info?.last_exit ? `exit ${info.last_exit.exit_code}`
        : info?.child ? `pid ${info.child.pid}` : "";
      lines.push(`${probe.role.toUpperCase()}: ${probe.state}  port ${probe.port ?? "?"}${details ? `  ${details}` : ""}`);
      if (probe.state === "conflict") lines.push(`  포트 점유 PID: ${probe.listeners.join(", ")} (자동 종료하지 않음)`);
      if (config && probe.port !== config[probe.role]) lines.push(`  설정 포트 ${config[probe.role]} 적용: /lb restart`);
    }
    return lines.join("\n");
  }

  private async checkReservations(target: Target, ports: number[]): Promise<void> {
    for (const session of sessions().filter((item) => item.label === SESSION_LABEL || item.label.startsWith("lb:"))) {
      for (const block of managedBlocks(session.session_id)) {
        if (block.targetId !== target.id && ports.includes(block.port) && !block.program.last_exit) {
          throw new Error(`포트 ${block.port}는 ${session.label} 세션의 다른 worktree (${block.targetId}) ${block.role.toUpperCase()}에서 사용/시작 중입니다.`);
        }
      }
    }
  }

  async start(target: Target, { restart = false } = {}): Promise<Session> {
    return this.locked(async () => {
      const config = configFor(target.root);
      if (!existsSync(join(target.root, "manage.py")) || !existsSync(join(target.root, "app/package.json"))
        || !statSync(join(target.root, "app")).isDirectory()) {
        throw new Error("manage.py와 app/package.json이 있는 lemonbase worktree가 필요합니다.");
      }
      if (config.worktrunk && !config.domain.endsWith(".lemonbase.test")) {
        throw new Error("Worktrunk 도메인은 .lemonbase.test로 끝나야 합니다.");
      }
      if (restart) {
        // Keep the same lock across shutdown and startup so other /lb operations cannot interleave.
        const result = await this.stopUnlocked(target);
        if (result.warning) throw new Error(`종료 중 문제가 있어 재시작을 중단했습니다.\n${result.message}`);
      }
      let session = findSession(target);
      if (session && session.label !== SESSION_LABEL) {
        throw new Error("기존 worktree별 Rex 세션에서 실행 중입니다. /lb restart로 공통 lb 세션의 브랜치명 창으로 옮겨 주세요. 기존 프로세스는 종료하지 않았습니다.");
      }
      const probes = await this.inspect(target, session, config);
      for (const probe of probes) {
        if (probe.state === "conflict" || probe.state === "unknown") {
          throw new Error(`${probe.role.toUpperCase()}: ${probe.state}, port ${probe.port}. /lb status와 Rex 로그를 확인해 주세요. 기존 프로세스는 종료하지 않았습니다.`);
        }
        if (probe.block && !probe.block.program.last_exit && probe.port !== config[probe.role]) {
          throw new Error("실행 중인 서버와 설정 포트가 다릅니다. /lb restart 해 주세요.");
        }
      }
      if (session) {
        const windows = new Set(probes.flatMap((probe) => probe.block?.window_id ? [probe.block.window_id] : []));
        for (const window of windows) {
          rexCall("session.set_window_label", session.session_id, { window_id: window, label: target.windowLabel });
        }
      }
      const needed = probes.filter((probe) => !probe.block || probe.block.program.last_exit);
      if (needed.length === 0 && session) return session;
      await this.checkReservations(target, [config.be, config.fe]);
      for (const probe of needed) {
        // A stopped block may still record an old port after the configuration changes.
        const occupied = await this.listeners(config[probe.role]);
        if (occupied.length) throw new Error(`포트 ${config[probe.role]}를 PID ${occupied.join(", ")}에서 사용 중입니다. 자동 종료하지 않습니다.`);
      }
      if (config.worktrunk) {
        await this.run("bash", ["./scripts/worktrunk/setup_caddy.sh", config.domain.slice(0, -".lemonbase.test".length),
          basename(PRIMARY), String(config.be), String(config.fe)], target.root, 30_000);
      }
      if (!session) {
        const created = rexCall<{ session_id: string }>("session.create", undefined, {
          label: SESSION_LABEL, initial_windows: [{ window_label: target.windowLabel, layout: devLayout(target, config) }],
        });
        session = { session_id: created.session_id, label: SESSION_LABEL };
      } else {
        for (const probe of needed) {
          if (probe.block) rexCall("block.close", session.session_id, { block_id: probe.block.block_id });
        }
        if (needed.length === 2) {
          rexCall("session.new_window", session.session_id, { window_label: target.windowLabel, layout: devLayout(target, config), focus: false });
        } else {
          const role = needed[0]!.role;
          const peer = managedBlocks(session.session_id, target.id).find((block) => block.placement === "placed");
          if (peer) {
            rexCall("session.new_split", session.session_id, { anchor_id: peer.block_id, direction: "horizontal",
              side: role === "be" ? "before" : "after", layout: layout(target, config, role), focus: false });
          } else {
            rexCall("session.new_window", session.session_id, { window_label: target.windowLabel, layout: layout(target, config, role), focus: false });
          }
        }
      }
      return session;
    });
  }

  async stop(target: Target): Promise<{ message: string; warning: boolean }> {
    return this.locked(() => this.stopUnlocked(target));
  }

  private async stopUnlocked(target: Target): Promise<{ message: string; warning: boolean }> {
    const session = findSession(target);
    if (!session) return { message: `${target.root}\n중지할 /lb 세션이 없습니다. 다른 프로세스는 건드리지 않았습니다.`, warning: false };
    const blocks = managedBlocks(session.session_id, target.id);
    if (!blocks.length) return { message: `${target.root}\n중지할 BE/FE 블록이 없습니다. 다른 worktree와 사용자 블록은 보존했습니다.`, warning: false };
    const errors: string[] = [];
    for (const block of blocks) {
      if (block.program.last_exit) continue;
      try {
        rexCall("com.superlogical.terminal.write", session.session_id, { block_id: block.block_id, args: { data: "\u0003" } });
      } catch (error) { errors.push(`${block.role.toUpperCase()}: ${errorMessage(error)}`); }
    }
    const deadline = Date.now() + 5_000;
    try {
      while (Date.now() < deadline) {
        const live = rexBlocks(session.session_id).filter((block) => blocks.some((owned) => owned.block_id === block.block_id));
        if (live.every((block) => program(session.session_id, block.block_id).last_exit)) break;
        await delay(200);
      }
    } catch (error) { errors.push(`종료 대기: ${errorMessage(error)}`); }
    for (const block of blocks) {
      try {
        if (rexBlocks(session.session_id).some((current) => current.block_id === block.block_id)) {
          rexCall("block.close", session.session_id, { block_id: block.block_id });
        }
      } catch (error) { errors.push(`${block.role.toUpperCase()}: ${errorMessage(error)}`); }
    }
    const remaining = rexBlocks(session.session_id);
    const ownedRemaining = remaining.filter((block) => blocks.some((owned) => owned.block_id === block.block_id));
    if (remaining.length === 0) rexCall("session.destroy", session.session_id);
    if (ownedRemaining.length) errors.push(`${ownedRemaining.length}개 관리 블록을 종료하지 못했습니다. /lb stop으로 다시 시도해 주세요.`);
    const busy = await Promise.all(blocks.map(async (block) => {
      const pids = await this.listeners(block.port);
      return pids.length ? `${block.port}: PID ${pids.join(", ")}가 아직 LISTEN 중입니다. 별도로 확인해 주세요.` : "";
    }));
    const notes = [...errors, ...busy.filter(Boolean)];
    const summary = ownedRemaining.length ? "BE/FE 일부 종료 실패."
      : remaining.length ? "BE/FE 종료 완료. 다른 worktree와 사용자 블록은 보존했습니다." : "BE/FE 종료 및 Rex 세션 정리 완료.";
    return { message: [target.root, summary, ...notes].join("\n"), warning: notes.length > 0 };
  }
}
