import { Cron } from 'croner';
import { spawn } from 'node:child_process';
import { createServer, createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync, readdirSync, lstatSync, realpathSync, unlinkSync, rmSync, rmdirSync, openSync, closeSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { join, dirname, resolve, isAbsolute, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const defaultRoot = () => join(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'), 'fire');
const errorText = e => e instanceof Error ? e.message : String(e);
const CLOCK_CHECK_MS = 60_000;
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function atomicJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  renameSync(temp, path);
}
function json(path, fallback) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
}
export function cronPreview(pattern, now = new Date(), timezone = osTimezone(), count = 5) {
  if (typeof pattern !== 'string') throw new Error('Cron must be a five-field string');
  const fields = pattern.trim().split(/\s+/);
  const basic = fields.map((f, i) => i === 3 ? f.replace(/JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC/gi, '1') : i === 4 ? f.replace(/SUN|MON|TUE|WED|THU|FRI|SAT/gi, '1') : f);
  if (fields.length !== 5 || basic.some(f => !/^[\d*,/\-]+$/.test(f))) throw new Error('Use standard five-field Unix cron (no seconds, Quartz, L, #, or ?)');
  const cron = new Cron(pattern, { timezone, legacyMode: true, paused: true });
  try {
    const next = cron.nextRuns(count, new Date(now));
    if (!next.length) throw new Error('Cron has no future occurrence');
    return next.map(d => d.toISOString());
  } finally { cron.stop(); }
}
export function osTimezone() {
  // macOS changes /etc/localtime while a long-lived Node/ICU process may cache the old zone.
  if (process.platform === 'darwin') {
    try { const path = realpathSync('/etc/localtime'); const zone = path.split('/zoneinfo/')[1]; if (zone) return zone; } catch {}
  }
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}
export function validateConfig(input, scheduled = false, checkFolder = true) {
  if (!input || typeof input !== 'object') throw new Error('Missing configuration');
  const { cwd, mode, prompt } = input;
  if (!isAbsolute(cwd || '') || (checkFolder && !lstatSync(realpathSync(cwd)).isDirectory())) throw new Error('Working folder must be an existing absolute directory');
  if (!['run', 'run-worktree'].includes(mode)) throw new Error('Choose run or run-worktree');
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('Prompt is required');
  const result = { cwd: checkFolder ? realpathSync(cwd) : cwd, mode, prompt: prompt.trim() };
  if (mode === 'run-worktree') {
    result.remote = input.remote || 'origin';
    result.base = input.base || '';
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(result.remote)) throw new Error('Invalid remote name');
    if (result.base && (!/^[a-zA-Z0-9][a-zA-Z0-9._/\-]*$/.test(result.base) || result.base.includes('..'))) throw new Error('Base must be a remote branch name');
  }
  if (scheduled) {
    if (typeof input.name !== 'string' || !input.name.trim()) throw new Error('Name is required');
    cronPreview(input.cron);
    if (!['skip', 'parallel'].includes(input.overlap || 'skip')) throw new Error('Overlap must be skip or parallel');
    Object.assign(result, { name: input.name.trim(), cron: input.cron.trim(), enabled: input.enabled !== false, overlap: input.overlap || 'skip' });
  } else if (input.model) {
    if (typeof input.model.provider !== 'string' || typeof input.model.id !== 'string') throw new Error('Invalid selected model');
    result.model = { provider: input.model.provider, id: input.model.id };
    if (!['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.thinking)) throw new Error('Invalid thinking level');
    result.thinking = input.thinking;
  }
  return result;
}
export function parseCommand(args) {
  const text = args.trim();
  if (!text) return { action: 'ui' };
  if (text === 'tool') return { action: 'tool' };
  if (text === 'run' || text === 'run-worktree') return { action: 'run', mode: text, prompt: '' };
  const match = /^(run-worktree|run)\s+([\s\S]+)$/.exec(text);
  if (!match || !match[2].trim()) throw new Error('Usage: /fire | /fire run [PROMPT] | /fire run-worktree [PROMPT] | /fire tool');
  return { action: 'run', mode: match[1], prompt: match[2].trim() };
}
export function runCommand(command, args, { cwd, env = process.env } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', s => { stdout += s; });
    child.stderr.on('data', s => { stderr += s; });
    child.once('error', reject);
    child.once('close', (code, signal) => code === 0 ? resolveResult({ stdout, stderr, code }) : reject(Object.assign(new Error(`${command} ${args.join(' ')}: ${signal || code}\n${stderr || stdout}`), { stdout, stderr, code, signal })));
  });
}
function ownedPath(root, path) {
  const rel = relative(root, path);
  if (!rel || rel.startsWith('..' + sep) || rel === '..' || isAbsolute(rel)) throw new Error(`MANUAL: path outside Fire ownership: ${path}`);
  let current = root;
  if (realpathSync(root) !== root) throw new Error('MANUAL: Fire storage root changed');
  for (const part of rel.split(sep)) {
    current = join(current, part);
    try { if (lstatSync(current).isSymbolicLink()) throw new Error(`MANUAL: symbolic link in owned path: ${current}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return path;
}
function checkOwnedTree(root, path) {
  ownedPath(root, path);
  if (!existsSync(path)) return;
  for (const name of readdirSync(path)) {
    const child = ownedPath(root, join(path, name));
    if (lstatSync(child).isDirectory()) checkOwnedTree(root, child);
  }
}
export function worktreeBranchName(run) {
  // ponytail: ASCII task words keep Worktrunk hostnames portable; use model-based naming if non-Latin-only tasks need descriptive slugs.
  const task = (run.config.name || run.config.prompt).replace(/<skill\b[^>]*>[\s\S]*?<\/skill>/g, '').replace(/^(?:\/skill:\S+\s*)+/, '');
  const slug = task.normalize('NFKD').replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '') || 'task';
  return `fire/${slug}-${run.id.slice(0, 8)}`;
}
export class Worktrees {
  constructor(root, { exec = runCommand, env = process.env, wt = 'wt' } = {}) { this.root = root; this.exec = exec; this.env = env; this.wt = wt; }
  async git(cwd, ...args) { return (await this.exec('git', args, { cwd, env: { ...this.env, GIT_TERMINAL_PROMPT: '0' } })).stdout.trim(); }
  async wtRun(cwd, args, env = {}) { return this.exec(this.wt, args, { cwd, env: { ...this.env, ...env, NO_COLOR: '1' } }); }
  async approved(cwd, phases, env = {}) {
    const data = JSON.parse((await this.wtRun(cwd, ['config', 'approvals', 'list', '--format=json'], env)).stdout);
    if (!['approved', 'no_commands', 'approval_required'].includes(data.state) || !Array.isArray(data.commands)) throw new Error('MANUAL: unknown Worktrunk approval response');
    const denied = data.commands.filter(c => phases.includes(c.phase) && c.approved !== true);
    if (denied.length) throw new Error(`Required Worktrunk approval unavailable: ${denied.map(c => c.phase + ':' + (c.name || c.template)).join(', ')}`);
  }
  async hook(run, cwd, phase, vars = {}, env = {}) {
    await this.approved(cwd, [phase], env);
    const log = output => appendFileSync(ownedPath(this.root, join(this.root, 'runs', run.id, 'hooks.log')), `\n--- ${new Date().toISOString()} ${phase} ---\nstdout:\n${output.stdout || ''}\nstderr:\n${output.stderr || (output instanceof Error ? errorText(output) : '')}\n`, { mode: 0o600 });
    let result;
    try { result = await this.wtRun(cwd, ['hook', phase, '--foreground', ...Object.entries(vars).flatMap(([key, value]) => ['--var', `${key}=${value}`])], env); }
    catch (e) { log(e); throw e; }
    log(result);
    await this.approved(cwd, [phase], env);
    // ponytail: installed wt can exit 0 on hook failure; conservative diagnostics until wt exposes structured execution status.
    if (/^\s*✗|^.*Command failed:/mu.test(stripVTControlCharacters(result.stderr))) throw new Error(`Worktrunk ${phase} reported failure: ${result.stderr.trim()}`);
    return result;
  }
  async prepare(run, save) {
    const source = run.config.cwd;
    const path = ownedPath(this.root, join(this.root, 'worktrees', run.id));
    if (existsSync(path)) throw new Error('MANUAL: planned worktree already exists');
    const common = realpathSync(await this.git(source, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
    const branch = worktreeBranchName(run);
    const remote = run.config.remote || 'origin';
    let base = run.config.base;
    if (!base) {
      const output = await this.git(source, 'ls-remote', '--symref', remote, 'HEAD');
      base = /^ref: refs\/heads\/(.+)\s+HEAD$/m.exec(output)?.[1];
      if (!base) throw new Error('Remote default branch could not be resolved; no fallback');
    }
    await this.git(source, 'check-ref-format', `refs/heads/${base}`);
    // FETCH_HEAD is shared by concurrent worktrees; each run owns its fetch destination.
    const fetchRef = `refs/fire-fetch/${run.id}`;
    await this.git(source, 'fetch', '--no-tags', '--no-write-fetch-head', remote, `refs/heads/${base}:${fetchRef}`);
    const baseCommit = await this.git(source, 'rev-parse', '--verify', `${fetchRef}^{commit}`);
    await this.git(source, 'update-ref', '-d', fetchRef, baseCommit);
    Object.assign(run, { worktree: { path, branch, common, base, baseCommit, remote, token: randomUUID(), created: false }, executionCwd: path }); save();
    await this.approved(source, ['pre-switch', 'pre-start', 'post-start', 'post-switch']);
    await this.hook(run, source, 'pre-switch', { base: `${remote}/${base}`, base_worktree_path: source });
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    // Phase orchestration keeps native hooks foreground, rather than accepting detached setup/removal.
    await this.wtRun(source, ['--config-set', `worktree-path=${JSON.stringify(path)}`, 'switch', '--create', branch, '--base', baseCommit, '--no-cd', '--no-hooks', '--format=json']);
    const actual = await this.git(path, 'symbolic-ref', 'HEAD');
    if (actual !== `refs/heads/${branch}` || realpathSync(path) !== path || await this.git(path, 'rev-parse', 'HEAD') !== baseCommit) throw new Error('MANUAL: created worktree identity mismatch');
    const gitDir = realpathSync(await this.git(path, 'rev-parse', '--absolute-git-dir'));
    if (realpathSync(await this.git(path, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== common || !gitDir.startsWith(join(common, 'worktrees') + sep)) throw new Error('MANUAL: unexpected Git worktree ownership');
    const stat = lstatSync(path);
    Object.assign(run.worktree, { created: true, gitDir, dev: stat.dev, ino: stat.ino });
    writeFileSync(join(gitDir, 'fire-owner'), run.worktree.token, { flag: 'wx', mode: 0o600 }); save();
    const vars = { base: `${remote}/${base}`, base_worktree_path: source };
    for (const phase of ['pre-start', 'post-start', 'post-switch']) await this.hook(run, path, phase, vars);
  }
  async verify(run) {
    const w = run.worktree;
    if (!w?.created || !w.gitDir || !w.token) throw new Error('MANUAL: worktree ownership not established');
    if (w.path !== join(this.root, 'worktrees', run.id)) throw new Error('MANUAL: worktree path mismatch');
    ownedPath(this.root, w.path);
    const stat = lstatSync(w.path);
    if (stat.dev !== w.dev || stat.ino !== w.ino || realpathSync(w.path) !== w.path) throw new Error('MANUAL: worktree directory replaced');
    if (readFileSync(join(w.gitDir, 'fire-owner'), 'utf8') !== w.token) throw new Error('MANUAL: ownership token mismatch');
    if (realpathSync(await this.git(w.path, 'rev-parse', '--absolute-git-dir')) !== w.gitDir || realpathSync(await this.git(w.path, 'rev-parse', '--path-format=absolute', '--git-common-dir')) !== w.common || await this.git(w.path, 'symbolic-ref', 'HEAD') !== `refs/heads/${w.branch}`) throw new Error('MANUAL: worktree Git identity changed');
    const registered = await this.git(run.config.cwd, 'worktree', 'list', '--porcelain');
    if (!registered.split('\n\n').some(block => block.includes(`worktree ${w.path}\n`) && block.includes(`branch refs/heads/${w.branch}`))) throw new Error('MANUAL: worktree is not registered to this repository');
  }
  async remove(run, save) {
    if (run.runtime !== 'terminated') throw new Error('MANUAL: worker termination is not confirmed');
    await this.verify(run);
    const w = run.worktree;
    w.finalCommit = await this.git(w.path, 'rev-parse', 'HEAD');
    const vars = { branch: w.branch, worktree_path: w.path, worktree_name: w.path.split(sep).at(-1), commit: w.finalCommit, short_commit: w.finalCommit.slice(0, 12) };
    const configPath = this.env.WORKTRUNK_PROJECT_CONFIG_PATH || '.config/wt.toml';
    const source = isAbsolute(configPath) ? configPath : join(w.path, configPath);
    const snapshot = ownedPath(this.root, join(this.root, 'runs', run.id, 'worktrunk-project.toml'));
    writeFileSync(snapshot, existsSync(source) ? readFileSync(source) : '', { mode: 0o600 });
    await this.approved(w.path, ['pre-remove', 'post-remove']);
    run.cleanup = 'removing'; save();
    await this.hook(run, w.path, 'pre-remove');
    await this.verify(run);
    const removed = await this.wtRun(run.config.cwd, ['remove', w.path, '--foreground', '--force', '--no-hooks', '--format=json']);
    w.removalResult = removed.stdout.trim(); save();
    if (existsSync(w.path) || (await this.git(run.config.cwd, 'worktree', 'list', '--porcelain')).includes(`worktree ${w.path}\n`)) throw new Error('MANUAL: Worktrunk returned but worktree remains');
    await this.hook(run, run.config.cwd, 'post-remove', vars, { WORKTRUNK_PROJECT_CONFIG_PATH: snapshot });
    run.cleanup = 'removed'; save();
  }
}

export function assistantResultFromEntries(entries) {
  const message = entries.findLast(entry => entry.type === 'message' && entry.message?.role === 'assistant')?.message;
  const text = typeof message?.content === 'string' ? message.content : (message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n');
  return { text, error: message?.stopReason === 'error' ? message.errorMessage || 'Assistant execution failed.' : undefined };
}
function lines(stream, receive) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', chunk => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); if (line.trim()) receive(line); }
  });
}
export class PiWorker {
  constructor(run, { cli, env = process.env, onUpdate = () => {}, spawnWorker = spawn, timeoutMs = 15000 } = {}) {
    this.run = run; this.onUpdate = onUpdate; this.timeoutMs = timeoutMs;
    this.pending = new Map(); this.closed = false; this.stopping = false; this.finishing = false; this.settled = false;
    const args = [cli, '--mode', 'rpc', '--session-dir', run.sessionDir, '-e', join(here, 'index.ts')];
    if (run.config.model) args.push('--provider', run.config.model.provider, '--model', run.config.model.id, '--thinking', run.config.thinking);
    this.child = spawnWorker(process.execPath, args, { cwd: run.executionCwd, env: { ...env, PI_FIRE_WORKER: run.token, PI_FIRE_RUN_ID: run.id, PI_FIRE_ROOT: dirname(dirname(dirname(run.sessionDir))) }, stdio: ['pipe', 'pipe', 'pipe'] });
    this.done = new Promise(resolveDone => {
      this.child.once('error', e => { this.spawnError = errorText(e); });
      this.child.once('close', (code, signal) => {
        this.closed = true; clearInterval(this.poller);
        for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(new Error('Pi worker closed')); }
        this.pending.clear();
        resolveDone({ code, signal, clean: this.shutdownAcknowledged === true, error: this.spawnError });
      });
    });
    this.child.stdin.on('error', () => {});
    lines(this.child.stdout, line => { try { this.receive(JSON.parse(line)); } catch (e) { this.run.workerError = `Invalid Pi RPC: ${errorText(e)}`; this.onUpdate(); } });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', s => { this.run.workerLog = ((this.run.workerLog || '') + s).slice(-16000); this.onUpdate(); });
  }
  send(value) { this.child.stdin.write(JSON.stringify(value) + '\n'); }
  request(type, data = {}) {
    if (this.closed) return Promise.reject(new Error('Worker already closed'));
    const id = randomUUID();
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`MANUAL: Pi ${type} acknowledgement unavailable`)); }, this.timeoutMs);
      this.pending.set(id, { resolve: resolveResult, reject, timer }); this.send({ id, type, ...data });
    });
  }
  receive(event) {
    if (event.type === 'response') {
      const request = this.pending.get(event.id); if (!request) return;
      clearTimeout(request.timer); this.pending.delete(event.id);
      event.success ? request.resolve(event.data) : request.reject(new Error(event.error || `Pi rejected ${event.command}`));
    } else if (event.type === 'extension_ui_request' && ['select', 'confirm', 'input', 'editor'].includes(event.method)) {
      this.send({ type: 'extension_ui_response', id: event.id, cancelled: true });
    } else if (event.type === 'agent_start') this.settled = false;
    else if (event.type === 'agent_settled') {
      this.settled = true;
      this.run.aborted = event.aborted === true;
      this.onUpdate();
      void this.inspect();
    }
    else if (event.type === 'extension_error') {
      this.run.workerError = event.error;
      if (event.extensionPath === 'command:fire-worker-start') this.startError = event.error;
      if (event.event === 'send_user_message') {
        this.run.error = event.error; this.settled = true; void this.inspect();
      }
      this.onUpdate();
    }
  }
  async start() {
    const state = await this.request('get_state');
    Object.assign(this.run, { sessionFile: state.sessionFile, actualModel: state.model && { provider: state.model.provider, id: state.model.id }, actualThinking: state.thinkingLevel });
    this.onUpdate();
    if (!state.model) throw new Error('No Pi model is available; configure authentication in interactive Pi first');
    let prompt = this.run.config.prompt;
    if (this.run.config.mode === 'run-worktree') prompt += `\n\nFire has already prepared branch ${JSON.stringify(this.run.worktree.branch)} for this task. Use it for any requested commits, pushes and PRs; do not create, switch or rename branches.`;
    await this.request('prompt', { message: `/fire-worker-start ${this.run.token}\n${prompt}` });
    if (this.startError) throw new Error(this.startError);
    if (!this.closed) this.poller = setInterval(() => { void this.inspect(); }, 750);
  }
  async collect() {
    const { entries } = await this.request('get_entries');
    const result = assistantResultFromEntries(entries);
    this.run.result = result.text;
    const blocked = entries.findLast(entry => entry.type === 'custom_message' && entry.customType === 'fire-blocked');
    this.run.blocked = typeof blocked?.content === 'string' ? blocked.content : undefined;
    const text = entries.filter(e => ['message', 'custom_message', 'custom'].includes(e.type)).map(e => JSON.stringify(e)).join('\n');
    this.run.observedPrUrls = [...new Set(text.match(/https:\/\/[^\s"<>\\]+\/pull\/[0-9]+/g) || [])];
    this.onUpdate();
    return result.error;
  }
  async inspect() {
    if (this.closed || this.inspecting || this.finishing || this.stopping) return;
    this.inspecting = true;
    const settled = this.settled;
    try {
      const error = await this.collect();
      // A snapshot requested before settlement may not contain the final response yet.
      if (settled && this.settled && !this.stopping) {
        if (error) this.run.error ||= error;
        await this.finish();
      }
    } catch (e) { if (!this.closed) { this.run.workerError = errorText(e); this.onUpdate(); } }
    finally { this.inspecting = false; }
  }
  async finish() {
    if (this.finishing || this.closed) return;
    this.finishing = true;
    try {
      this.run.usage = await this.request('get_session_stats');
      await this.request('prompt', { message: `/fire-worker-exit ${this.run.token}` });
      this.shutdownAcknowledged = true;
    } catch (e) { this.run.workerError = errorText(e); this.finishing = false; this.onUpdate(); }
  }
  async stop() {
    if (this.closed) return;
    this.stopping = true;
    await this.request('prompt', { message: `/fire-worker-stop ${this.run.token}` });
    await this.request('clear_queue');
    await this.request('abort');
    const error = await this.collect();
    if (error) this.run.error ||= error;
    this.settled = true; this.onUpdate(); await this.finish();
  }
}

export class FireHost {
  constructor(root, { cli, worktrees, workerFactory, now = () => Date.now(), timezone = osTimezone } = {}) {
    mkdirSync(root, { recursive: true, mode: 0o700 }); this.root = realpathSync(root);
    this.cli = cli; this.now = now; this.timezone = timezone; this.zone = timezone();
    this.schedulerActive = false; this.schedulerTimer = undefined;
    this.worktrees = worktrees || new Worktrees(this.root);
    this.workerFactory = workerFactory || ((run, onUpdate) => new PiWorker(run, { cli: this.cli, onUpdate }));
    const savedSchedules = json(join(this.root, 'schedules.json'), []);
    // Legacy archives become paused schedules, never silently resumed or erased.
    this.schedules = savedSchedules.map(({ archived, ...schedule }) => archived ? { ...schedule, enabled: false } : schedule);
    if (savedSchedules.some(schedule => 'archived' in schedule)) this.saveSchedules();
    this.runs = new Map(); this.live = new Map(); this.next = new Map(); this.deleting = new Set(); this.deletingSchedules = new Set();
    mkdirSync(join(this.root, 'runs'), { recursive: true, mode: 0o700 });
    for (const id of readdirSync(join(this.root, 'runs'))) {
      if (!/^[a-f0-9-]{36}$/.test(id)) continue;
      const run = json(ownedPath(this.root, join(this.root, 'runs', id, 'run.json')), null);
      if (!run) continue;
      if (run.id !== id) throw new Error(`MANUAL: run bucket identity mismatch: ${id}`);
      this.runs.set(id, run);
      if (run.runtime !== 'terminated' && run.runtime !== 'skipped') {
        run.runtime = 'unknown'; run.manual = 'Host restarted without the owned worker handle. Inspect session/resources manually; no PID killing, replay, or cleanup retry.'; this.saveRun(run);
      } else if (run.cleanup === 'removing' || run.cleanup === 'pending') {
        run.cleanup = 'manual'; run.manual = 'Host restarted before cleanup confirmation. Inspect resources manually; no automatic cleanup retry.'; this.saveRun(run);
      }
    }
    this.recalculate();
  }
  saveRun(run) { atomicJson(ownedPath(this.root, join(this.root, 'runs', run.id, 'run.json')), run); }
  saveSchedules() { atomicJson(join(this.root, 'schedules.json'), this.schedules); }
  recalculate() {
    this.zone = this.timezone(); this.next.clear();
    for (const schedule of this.schedules) if (schedule.enabled) this.next.set(schedule.id, Date.parse(cronPreview(schedule.cron, this.now(), this.zone, 1)[0]));
    this.lastTick = this.now();
    this.scheduleCheck();
  }
  startScheduler() { this.schedulerActive = true; this.scheduleCheck(); }
  stopScheduler() { this.schedulerActive = false; clearTimeout(this.schedulerTimer); this.schedulerTimer = undefined; }
  scheduleCheck(minDelay = 1) {
    clearTimeout(this.schedulerTimer); this.schedulerTimer = undefined;
    // No periodic wakeups for an empty or paused schedule set.
    if (!this.schedulerActive || !this.next.size) return;
    const due = Math.min(...this.next.values());
    // Cron is minute-granular. Bound the wait to detect wall-clock/timezone changes
    // and sleep/resume without native watchers or a once-per-second polling loop.
    const delay = Math.max(minDelay, Math.min(CLOCK_CHECK_MS, due - this.now()));
    this.schedulerTimer = setTimeout(() => {
      let retryDelay = 1;
      try { this.tick(); }
      catch (e) {
        console.error(errorText(e));
        // A failed due-time check must not spin on an already-past deadline.
        retryDelay = CLOCK_CHECK_MS;
      } finally { this.scheduleCheck(retryDelay); }
    }, delay);
    this.schedulerTimer.unref();
  }
  list() {
    return { schedules: this.schedules.map(s => ({ ...s, next: this.next.get(s.id) })), runs: [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt), timezone: this.next.size ? this.zone : this.timezone(), connected: true };
  }
  saveSchedule(input) {
    const config = validateConfig(input, true); const existing = input.id && this.schedules.find(s => s.id === input.id);
    if (input.id && (!existing || this.deletingSchedules.has(input.id))) throw new Error('Schedule no longer editable');
    const schedule = { ...config, id: existing?.id || randomUUID(), updatedAt: this.now() };
    if (existing) this.schedules[this.schedules.indexOf(existing)] = schedule; else this.schedules.push(schedule);
    this.saveSchedules(); this.recalculate(); return schedule;
  }
  async deleteSchedule(id) {
    const schedule = this.schedules.find(s => s.id === id); if (!schedule) throw new Error('Schedule not found');
    if (this.deletingSchedules.has(id)) throw new Error('Schedule deletion already in progress');
    const runs = [...this.runs.values()].filter(run => run.scheduleId === id);
    // Bulk deletion never stops workers or reconciles failed cleanup on the user's behalf.
    for (const run of runs) {
      if (this.live.has(run.id) || this.deleting.has(run.id) || !['terminated', 'skipped'].includes(run.runtime) || !['removed', 'not-required', 'not-created'].includes(run.cleanup) || (run.worktree && (run.cleanup !== 'removed' || existsSync(run.worktree.path)))) {
        throw new Error(`MANUAL: resolve run ${run.id} before deleting this schedule; no changes made`);
      }
      for (const path of this.runRecordPaths(run.id)) checkOwnedTree(this.root, path);
    }
    this.deletingSchedules.add(id);
    try {
      // Persist the pause first so a crash or partial failure cannot schedule more work.
      this.schedules = this.schedules.map(s => s.id === id ? { ...s, enabled: false } : s);
      this.recalculate(); this.saveSchedules();
      for (const run of runs) await this.deleteRun(run.id);
      const remaining = this.schedules.filter(s => s.id !== id);
      atomicJson(join(this.root, 'schedules.json'), remaining);
      this.schedules = remaining; this.recalculate();
      return { deletedSchedule: id, deletedRuns: runs.length };
    } catch (e) {
      throw new Error(`Schedule deletion incomplete; schedule remains paused in memory. Inspect storage before restarting; some history may already be deleted. ${errorText(e)}`);
    } finally { this.deletingSchedules.delete(id); }
  }
  runRecordPaths(id) {
    // Only fixed run-owned buckets, never arbitrary paths from prompts or metadata.
    return [join(this.root, 'test-perf-artifacts', id), join(this.root, 'runs', id)].map(path => ownedPath(this.root, path));
  }
  tick() {
    const now = this.now();
    if (this.zone !== this.timezone() || now < this.lastTick) { this.recalculate(); return; }
    for (const schedule of this.schedules) {
      const due = this.next.get(schedule.id); if (!due || due > now) continue;
      this.next.set(schedule.id, Date.parse(cronPreview(schedule.cron, now, this.zone, 1)[0]));
      // Only the current minute is eligible; waking late never reconstructs past rounds.
      if (Math.floor(due / 60000) !== Math.floor(now / 60000)) this.accept(schedule, schedule.id, 'missed while host unavailable');
      else this.accept(schedule, schedule.id);
    }
    this.lastTick = now;
  }
  accept(input, scheduleId, skipped) {
    if (scheduleId && (this.deletingSchedules.has(scheduleId) || !this.schedules.some(s => s.id === scheduleId))) throw new Error('Schedule unavailable or being deleted');
    const config = validateConfig(input, Boolean(scheduleId), !scheduleId);
    const worktreeRoot = join(this.root, 'worktrees');
    if (config.cwd === worktreeRoot || config.cwd.startsWith(worktreeRoot + sep)) throw new Error('Fire runs cannot use a disposable Fire worktree as their original folder');
    if (scheduleId && config.overlap === 'skip' && [...this.runs.values()].some(r => r.scheduleId === scheduleId && !['terminated', 'skipped'].includes(r.runtime))) skipped ||= 'overlap policy: skip (including unknown prior termination)';
    const id = randomUUID();
    const run = { id, token: randomUUID(), scheduleId: scheduleId || null, config: structuredClone(config), timezone: this.timezone(), startedAt: this.now(), runtime: skipped ? 'skipped' : 'preparing', cleanup: config.mode === 'run-worktree' && !skipped ? 'pending' : 'not-required', executionCwd: config.cwd, sessionDir: join(this.root, 'runs', id, 'sessions'), skipped };
    mkdirSync(run.sessionDir, { recursive: true, mode: 0o700 });
    this.runs.set(id, run); this.saveRun(run);
    if (!skipped) {
      const entry = { token: run.token, worker: null }; this.live.set(id, entry);
      entry.task = this.execute(run, entry);
    }
    return structuredClone(run);
  }
  async execute(run, entry) {
    let outcome;
    try {
      if (!lstatSync(run.config.cwd).isDirectory() || realpathSync(run.config.cwd) !== run.config.cwd) throw new Error('Original working folder is missing or changed identity; no fallback');
      if (run.config.mode === 'run-worktree') await this.worktrees.prepare(run, () => this.saveRun(run));
      if (run.stopRequested) { delete run.manual; outcome = { clean: true }; }
      else {
        try {
          run.git = { branch: await this.worktrees.git(run.executionCwd, 'symbolic-ref', '--short', 'HEAD'), initialCommit: await this.worktrees.git(run.executionCwd, 'rev-parse', 'HEAD') };
        } catch { /* General non-Git tasks are supported. */ }
        run.runtime = 'running'; this.saveRun(run);
        const worker = this.workerFactory(run, () => this.saveRun(run)); entry.worker = worker;
        try { await worker.start(); }
        catch (e) {
          run.error = `Pi startup failed: ${errorText(e)}`; run.workerError = errorText(e); this.saveRun(run);
          try { await worker.stop(); } catch (stopError) { run.manual = errorText(stopError); run.runtime = 'unknown'; this.saveRun(run); }
        }
        outcome = await worker.done;
      }
      run.exit = outcome;
      // A native shutdown acknowledgement plus actual child close is the owned-run barrier.
      run.runtime = outcome.clean ? 'terminated' : 'unknown';
      if (!outcome.clean) run.manual = outcome.error || 'Worker exited without confirmed native shutdown. Inspect resources manually.';
    } catch (e) {
      run.error = errorText(e); run.runtime = entry.worker ? 'unknown' : 'terminated';
      if (entry.worker) run.manual = 'Worker state unknown; do not remove its environment.';
    }
    if (run.runtime === 'terminated' && run.git) {
      try { run.git.finalCommit = await this.worktrees.git(run.executionCwd, 'rev-parse', 'HEAD'); } catch (e) { run.git.inspectionError = errorText(e); }
    }
    run.endedAt = this.now(); this.saveRun(run);
    if (run.config.mode === 'run-worktree') {
      if (run.runtime === 'terminated' && run.worktree?.created) {
        try { await this.worktrees.remove(run, () => this.saveRun(run)); }
        catch (e) { run.cleanup = 'manual'; run.manual = `Cleanup failed; inspect ${run.worktree.path}. ${errorText(e)}. No automatic retry.`; }
      } else if (run.worktree || run.runtime === 'unknown') {
        run.cleanup = 'manual'; run.manual ||= 'Worktree ownership or termination unconfirmed. Inspect manually; no fallback or automatic retry.';
      } else run.cleanup = 'not-created';
    }
    this.saveRun(run); this.live.delete(run.id);
  }
  async stop(id) {
    const run = this.runs.get(id); const entry = this.live.get(id);
    if (!run || !entry || entry.token !== run.token) throw new Error('MANUAL: no owned current worker handle; saved PIDs are never used');
    run.stopRequested = true; this.saveRun(run);
    if (!entry.worker) { run.manual = 'Stop requested during preparation. Waiting for the owned preparation command to finish; no cleanup until then.'; this.saveRun(run); }
    if (entry.worker) {
      try { await entry.worker.stop(); }
      catch (e) { run.runtime = 'unknown'; run.manual = errorText(e); this.saveRun(run); throw e; }
    }
    return run;
  }
  async deleteRun(id, manualCleanupVerified = false) {
    if (this.deleting.has(id)) throw new Error('Deletion already in progress for this run');
    this.deleting.add(id);
    try {
    const run = this.runs.get(id); if (!run) throw new Error('Run not found');
    if (this.live.has(id) || !['terminated', 'skipped'].includes(run.runtime)) throw new Error('MANUAL: cannot delete a live or unconfirmed execution');
    if (run.worktree && run.cleanup !== 'removed') {
      const w = run.worktree;
      if (w.path !== join(this.root, 'worktrees', id)) throw new Error('MANUAL: worktree path ownership mismatch; evidence retained');
      ownedPath(this.root, w.path);
      if (!existsSync(w.path)) {
        if (!manualCleanupVerified) throw new Error('MANUAL: missing worktree is not cleanup proof. Verify associated external resources manually and explicitly confirm reconciliation.');
        const common = realpathSync(await this.worktrees.git(run.config.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'));
        const topology = await this.worktrees.git(run.config.cwd, 'worktree', 'list', '--porcelain');
        if (common !== w.common || (w.gitDir && existsSync(w.gitDir)) || topology.split('\n').some(line => line === `worktree ${w.path}` || line === `branch refs/heads/${w.branch}`)) throw new Error('MANUAL: residual Git ownership/resources could not be reconciled');
        run.cleanup = 'removed'; run.manualReconciliation = { at: this.now(), externalResourcesVerifiedByUser: true, worktreeAndGitRegistrationAbsent: true }; delete run.manual; this.saveRun(run);
      } else {
        // Permanent deletion is an explicit destructive action, not an automatic cleanup retry.
        await this.worktrees.verify(run);
        try { await this.worktrees.remove(run, () => this.saveRun(run)); delete run.manual; }
        catch (e) { run.cleanup = 'manual'; run.manual = `Explicit deletion cleanup failed: ${errorText(e)}`; this.saveRun(run); throw e; }
      }
    }
    if (run.cleanup === 'manual' || run.cleanup === 'removing') throw new Error('MANUAL: reconcile failed cleanup/resources before deleting evidence.');
    if (run.worktree && existsSync(run.worktree.path)) throw new Error('MANUAL: worktree path exists again; evidence retained');
    const paths = this.runRecordPaths(id);
    for (const path of paths) checkOwnedTree(this.root, path);
    // Artifacts first: retain run metadata if their removal fails.
    for (const path of paths) if (existsSync(path)) rmSync(path, { recursive: true });
    this.runs.delete(id); return { deleted: id };
    } finally { this.deleting.delete(id); }
  }
  conversation(id) {
    const run = this.runs.get(id); if (!run) throw new Error('Run not found');
    const dir = ownedPath(this.root, join(this.root, 'runs', id, 'sessions'));
    const entries = []; let warning;
    // ponytail: full-history reads suit personal volumes; paginate native entries only when measured history latency warrants it.
    for (const name of readdirSync(dir).filter(n => n.endsWith('.jsonl'))) {
      const content = readFileSync(ownedPath(this.root, join(dir, name)), 'utf8');
      for (const line of content.split('\n')) if (line.trim()) { try { entries.push(JSON.parse(line)); } catch { warning = 'Incomplete/corrupt session line; original retained'; } }
    }
    return { entries, warning };
  }
  async dispatch(request) {
    switch (request.action) {
      case 'list': return this.list();
      case 'preview': return cronPreview(request.cron, this.now(), this.timezone());
      case 'save': return this.saveSchedule(request.config);
      case 'delete-schedule': return this.deleteSchedule(request.id);
      case 'pause': { const s = this.schedules.find(s => s.id === request.id); if (!s) throw new Error('Schedule not found'); return this.saveSchedule({ ...s, enabled: !s.enabled }); }
      case 'run': { if (request.id) { const s = this.schedules.find(s => s.id === request.id); if (!s) throw new Error('Schedule not found'); return this.accept(s, s.id); } return this.accept(request.config); }
      case 'stop': return this.stop(request.id);
      case 'delete': return this.deleteRun(request.id, request.manualCleanupVerified === true);
      case 'conversation': return this.conversation(request.id);
      default: throw new Error('Unknown Fire operation');
    }
  }
}

export function socketPath(root) { return join(root, 'host.sock'); }
export function requestHost(root, request, timeoutMs = 20000) {
  return new Promise((resolveResult, reject) => {
    const socket = createConnection(socketPath(root));
    const timer = setTimeout(() => socket.destroy(new Error('Fire connection timed out; reconnect with g')), timeoutMs);
    let responded = false;
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'));
    lines(socket, line => { responded = true; try { const response = JSON.parse(line); response.ok ? resolveResult(response.data) : reject(new Error(response.error)); } catch (e) { reject(e); } socket.end(); });
    socket.once('error', reject);
    socket.once('close', () => { clearTimeout(timer); if (!responded) reject(new Error('Fire disconnected before acknowledging the request; reconnect to inspect its result.')); });
  });
}
export async function serve(root, options = {}) {
  mkdirSync(root, { recursive: true, mode: 0o700 }); root = realpathSync(root);
  // Serialize only startup (not host lifetime) so stale-socket unlink cannot race another bind.
  const startupLock = join(root, 'host-starting');
  try { mkdirSync(startupLock, { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') throw new Error(`Fire startup in progress or interrupted. Reconnect; if still unavailable inspect ${startupLock} manually. No lock stealing.`); throw e; }
  try {
  // A live kernel listener, not a saved PID, owns the host.
  const socket = socketPath(root);
  let previous;
  try { previous = lstatSync(socket); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { await requestHost(root, { action: 'list' }, 1000); throw new Error('Fire host already running'); }
  catch (e) { if (!['ECONNREFUSED', 'ENOENT'].includes(e.code)) throw e; }
  if (previous && existsSync(socket)) {
    const current = lstatSync(socket);
    if (previous.ino !== current.ino || previous.dev !== current.dev || !current.isSocket()) throw new Error('Fire socket ownership changed; reconnect rather than replace');
    unlinkSync(socket);
  }
  let host;
  const server = createServer(connection => {
    let handled = false;
    lines(connection, line => {
      if (handled) return; handled = true;
      Promise.resolve().then(() => host.dispatch(JSON.parse(line))).then(data => connection.end(JSON.stringify({ ok: true, data }) + '\n'), e => connection.end(JSON.stringify({ ok: false, error: errorText(e) }) + '\n'));
    });
    connection.on('error', () => {});
  });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(socket, done); });
  // No persistence/recovery writes occur before exclusive bind succeeds.
  try { host = new FireHost(root, options); host.startScheduler(); }
  catch (e) { host?.stopScheduler(); await new Promise(done => server.close(done)); throw e; }
  return { host, server, close: async () => { host.stopScheduler(); await new Promise(done => server.close(done)); } };
  } finally { rmdirSync(startupLock); }
}
export function launchdPlist(root, cli, path = process.env.PATH || '') {
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);
  const args = [process.execPath, join(here, 'runtime.mjs'), '--host', root, cli];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>dev.pi.fire</string><key>ProgramArguments</key><array>${args.map(a => `<string>${escape(a)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape(path)}</string><key>PI_CODING_AGENT_DIR</key><string>${escape(process.env.PI_CODING_AGENT_DIR || join(homedir(), '.pi', 'agent'))}</string></dict><key>StandardOutPath</key><string>${escape(join(root, 'host.log'))}</string><key>StandardErrorPath</key><string>${escape(join(root, 'host.log'))}</string></dict></plist>\n`;
}
export async function activate(root, cli, login = false) {
  mkdirSync(root, { recursive: true, mode: 0o700 }); root = realpathSync(root);
  if (login) {
    if (process.platform !== 'darwin') throw new Error('Login activation requires macOS launchd');
    const path = join(homedir(), 'Library', 'LaunchAgents', 'dev.pi.fire.plist');
    if (existsSync(path)) throw new Error(`Existing ${path}; inspect manually rather than overwrite`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, launchdPlist(root, cli), { mode: 0o600, flag: 'wx' });
    await runCommand('launchctl', ['bootstrap', `gui/${process.getuid()}`, path]);
  } else {
    const fd = openSync(join(root, 'host.log'), 'a', 0o600);
    try { const child = spawn(process.execPath, [join(here, 'runtime.mjs'), '--host', root, cli], { cwd: homedir(), detached: true, stdio: ['ignore', fd, fd] }); child.unref(); }
    finally { closeSync(fd); }
  }
  for (let i = 0; i < 50; i++) { try { return await requestHost(root, { action: 'list' }, 500); } catch { await sleep(100); } }
  throw new Error(`Fire activation unconfirmed; inspect ${join(root, 'host.log')}. Do not blindly retry login installation.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--host') {
  const [root, cli] = process.argv.slice(3);
  if (!root || !cli) throw new Error('Fire host requires explicit storage and Pi executable');
  await serve(root, { cli });
}
