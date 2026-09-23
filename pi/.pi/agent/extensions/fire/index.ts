import type { ExtensionAPI, ExtensionContext, SlashCommandInfo, Theme } from '@earendil-works/pi-coding-agent';
import { getPackageDir, keyText, stripFrontmatter } from '@earendil-works/pi-coding-agent';
import { Input, Editor, Markdown, Text, CombinedAutocompleteProvider, CURSOR_MARKER, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi, type AutocompleteProvider } from '@earendil-works/pi-tui';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defaultRoot, requestHost, activate, parseCommand, cronPreview, assistantResultFromEntries, validateConfig, osTimezone } from './runtime.mjs';

type Config = { id?: string; name: string; cwd: string; mode: 'run' | 'run-worktree'; cron: string; enabled: boolean; overlap: 'skip' | 'parallel'; prompt: string; remote?: string; base?: string };
type Run = { id: string; scheduleId: string | null; startedAt: number; endedAt?: number; runtime: string; cleanup: string; result?: string; blocked?: string; config: Config; manual?: string; error?: string; skipped?: string; [key: string]: unknown };
type Schedule = Config & { id: string; archived?: boolean; next?: number };
type Snapshot = { schedules: Schedule[]; runs: Run[]; timezone?: string; connected?: boolean };
type ViewState = { bucket: string; runId?: string; selections?: Record<string, string>; pane: number; tab: number; expanded: boolean; scroll: Record<string, number> };
const stateDefault = (): ViewState => ({ bucket: 'once', pane: 0, tab: 0, expanded: false, scroll: {} });
const disposal = 'Disposable worktree: dirty, staged, untracked AND ignored files are discarded after every confirmed terminal outcome. Conversation is NOT a file backup. Approved hooks may affect external resources. Save important results in the task itself.';
const stringError = (error: unknown) => error instanceof Error ? error.message : String(error);
const safe = (value: unknown) => String(value ?? '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
const date = (time?: number, timezone?: string) => time ? new Date(time).toLocaleString(undefined, timezone ? { timeZone: timezone } : undefined) : '—';
const singleLine = (value: unknown) => safe(value).replace(/\s+/g, ' ').trim();
const fit = (text: string, width: number) => {
  const clipped = truncateToWidth(text, Math.max(0, width), '…');
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)));
};
const pair = (left: string, right: string, width: number) => {
  const rightWidth = Math.min(visibleWidth(right), Math.max(0, Math.floor(width / 2)));
  return fit(left, Math.max(0, width - rightWidth - 1)) + (width > 0 ? ' ' : '') + fit(right, rightWidth);
};
const duration = (run: Run) => {
  if (run.runtime === 'skipped') return '-';
  const seconds = Math.max(0, Math.floor(((run.endedAt || Date.now()) - run.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
};
const shortDate = (time: number) => {
  const d = new Date(time); const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}.${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fieldInfo: Record<string, [string, string]> = {
  name: ['Name', 'A short name for this recurring task.'],
  cwd: ['Working folder', 'An absolute folder path. Each run starts a fresh Pi session here.'],
  mode: ['Execution mode', 'run uses this folder. run-worktree creates and then discards a fresh worktree.'],
  cron: ['Cron', 'Five fields: minute · hour · day · month · weekday. Uses the current Mac timezone.'],
  enabled: ['Schedule', 'Paused schedules keep their history and can still be run manually.'],
  overlap: ['Overlap', 'Skip an overlapping run, or allow parallel runs. Shared folders are not locked.'],
  remote: ['Remote', 'Default: origin. Existing Worktrunk hook approvals are required.'],
  base: ['Base branch', 'Leave empty to use the remote default branch. Every run fetches a fresh base.'],
  prompt: ['Prompt', 'Start with /skill:name; use @file for paths. Skills resolve at execution; no current conversation is inherited.'],
};
async function reconcileDeletion(ctx: ExtensionContext, run?: Run): Promise<boolean | undefined> {
  if (run?.cleanup !== 'manual') return false;
  const choice = await ctx.ui.select('Manual cleanup requires operator verification', ['Remove verified residual worktree (one explicit attempt)', 'I verified external resource cleanup after manual worktree removal', 'Cancel']);
  if (!choice || choice === 'Cancel') return undefined;
  return choice.startsWith('I verified');
}
export function runLabel(run: Run) {
  if (run.manual || run.runtime === 'unknown' || run.cleanup === 'manual') return 'MANUAL';
  if (run.runtime === 'skipped') return 'SKIPPED';
  if (run.runtime !== 'terminated' || ['pending', 'removing'].includes(run.cleanup)) return `${run.runtime}/${run.cleanup}`;
  return run.error ? 'ERROR' : run.stopRequested ? 'STOPPED' : run.blocked ? 'BLOCKED' : 'ENDED';
}

type FireToolLine = { text: string; tone: Parameters<Theme['fg']>[0] };
type FireToolDetails = { summary?: FireToolLine[]; truncated?: boolean };
function fireToolSummary(action: string, data: any): FireToolLine[] {
  const rows: FireToolLine[] = [];
  const add = (text: unknown, tone: FireToolLine['tone'] = 'muted') => rows.push({ text: truncateToWidth(singleLine(text), 240, '…'), tone });
  const runTone = (run: Run): FireToolLine['tone'] => {
    const label = runLabel(run);
    return ['MANUAL', 'BLOCKED'].includes(label) ? 'warning' : run.error ? 'error' : ['preparing', 'running'].includes(run.runtime) ? 'accent' : 'muted';
  };
  const runSummary = (run: Run) => run.manual || run.error || run.blocked || run.result || run.skipped || run.config.prompt;
  const scheduleState = (schedule: Schedule) => schedule.archived ? 'Archived' : schedule.enabled ? 'Active' : 'Paused';
  if (action === 'list' && Array.isArray(data?.schedules) && Array.isArray(data?.runs)) {
    const { schedules, runs } = data as Snapshot;
    add(`${schedules.length} schedules · ${runs.length} runs · ${data.timezone || 'Mac timezone'}`, 'accent');
    const attention = runs.filter(run => run.error || ['MANUAL', 'BLOCKED'].includes(runLabel(run))).length;
    if (attention) add(`! ${attention} ${attention === 1 ? 'run needs' : 'runs need'} attention · /fire to inspect`, 'warning');
    for (const schedule of schedules.slice(0, 2)) add(`${scheduleState(schedule)} · ${schedule.name} · ${schedule.cron}`);
    if (schedules.length > 2) add(`… ${schedules.length - 2} more schedules`, 'dim');
    for (const run of runs.slice(0, 2)) add(`${runLabel(run)} · ${run.id.slice(0, 8)} · ${runSummary(run)}`, runTone(run));
    if (runs.length > 2) add(`… ${runs.length - 2} more runs`, 'dim');
  } else if (['run', 'stop'].includes(action) && data?.runtime && data?.config) {
    const run = data as Run;
    add(action === 'run' ? 'Run accepted' : 'Stop requested', 'accent');
    add(`${runLabel(run)} · ${run.id}`, runTone(run));
    add(`${run.config.mode} · ${run.executionCwd || run.config.cwd}`);
    add(runSummary(run), runTone(run));
  } else if (['save', 'pause', 'archive'].includes(action) && data?.id && typeof data?.cron === 'string') {
    add(`${action === 'save' ? 'Schedule saved' : action === 'archive' ? 'Schedule archived' : data.enabled ? 'Schedule resumed' : 'Schedule paused'} · ${data.name}`, 'success');
    add(`${scheduleState(data)} · ${data.id}`);
    add(`${data.cron} · ${data.mode} · ${data.cwd}`);
  } else if (action === 'delete' && data?.deleted) {
    add(`Deleted run · ${data.deleted}`, 'success');
  } else if (action === 'preview' && Array.isArray(data)) {
    add(`Next runs · ${osTimezone()}`, 'accent');
    for (const time of data.slice(0, 5)) add(date(Date.parse(time)));
  } else if (action === 'conversation' && Array.isArray(data?.entries)) {
    add(`Conversation · ${data.entries.length} entries`, 'accent');
    if (data.warning) add(data.warning, 'warning');
    const result = assistantResultFromEntries(data.entries);
    if (result.error) add(result.error, 'error');
    if (result.text.trim()) add(result.text);
  }
  return rows;
}

const editorTheme = (theme: () => Theme) => ({ borderColor: (s: string) => theme().fg('border', s), selectList: { selectedPrefix: (s: string) => theme().fg('accent', s), selectedText: (s: string) => theme().fg('accent', s), description: (s: string) => theme().fg('muted', s), scrollInfo: (s: string) => theme().fg('dim', s), noMatch: (s: string) => theme().fg('warning', s) } });

export async function expandFireSkills(prompt: string, commands: SlashCommandInfo[]): Promise<string> {
  const blocks: string[] = []; let remaining = prompt.trim();
  // Only explicit leading skill commands, from Pi's already-loaded/trusted catalog.
  // The worker submits literal prompt content, without dispatching extension commands.
  while (remaining.startsWith('/skill:')) {
    const match = /^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/.exec(remaining);
    const skill = commands.find(command => command.source === 'skill' && command.name === `skill:${match?.[1]}`);
    if (!skill) throw new Error(`Unknown or unavailable skill: ${match?.[1] || '(missing name)'}. Select a loaded /skill:name or reload Pi.`);
    const path = skill.sourceInfo.path;
    const body = stripFrontmatter(await readFile(path, 'utf8')).trim();
    blocks.push(`<skill name="${skill.name.slice(6)}" location="${path}">\nReferences are relative to ${dirname(path)}.\n\n${body}\n</skill>`);
    remaining = (match?.[2] || '').trim();
  }
  return [...blocks, remaining].filter(Boolean).join('\n\n');
}

export function firePromptAutocomplete(base: AutocompleteProvider): AutocompleteProvider {
  return {
    triggerCharacters: base.triggerCharacters,
    async getSuggestions(lines, line, col, options) {
      const result = await base.getSuggestions(lines, line, col, options);
      const before = (lines[line] || '').slice(0, col);
      // Skills are prompt content. Interactive commands such as /model or /fire are not run here.
      if (result && !options.force && before.startsWith('/') && !before.includes(' ')) {
        const items = result.items.filter(item => item.value.startsWith('skill:'));
        return items.length ? { ...result, items } : null;
      }
      return result;
    },
    applyCompletion: (...args) => base.applyCompletion(...args),
    shouldTriggerFileCompletion: (...args) => base.shouldTriggerFileCompletion?.(...args) ?? true,
  };
}

function fireFrame(theme: Theme, title: string, body: string[], width: number, height: number, footer: string[]) {
  const inner = Math.max(1, width - 2);
  const border = (text: string) => theme.fg('border', text);
  const row = (text: string) => border('│') + fit(text, inner) + border('│');
  const capacity = Math.max(0, height - footer.length - 5);
  return [border(`╭${'─'.repeat(inner)}╮`), row(` ${title}`), border(`├${'─'.repeat(inner)}┤`), ...Array.from({ length: capacity }, (_, i) => row(body[i] || '')), border(`├${'─'.repeat(inner)}┤`), ...footer.map(text => row(` ${text}`)), border(`╰${'─'.repeat(inner)}╯`)];
}

type ActionReview = { title: string; approve: string; danger: boolean; fields: [string, string][]; nextRuns: string[]; paused: boolean; prompt?: string; effect: string; warning?: string };
export function buildFireActionReview(request: any, now = new Date(), timezone = osTimezone()): ActionReview {
  const actions: Record<string, [string, string, string]> = {
    save: [request.config?.id ? 'Update schedule' : 'Create schedule', 'Save', 'Save future scheduling settings. Existing runs are unchanged.'],
    run: [request.id ? 'Run saved schedule' : 'Start background run', 'Run', request.id ? 'Start the latest saved configuration with Pi defaults. The recurring schedule is unchanged.' : 'Start a fresh background Pi task. Your current conversation is not inherited.'],
    pause: ['Toggle schedule', 'Toggle', 'Switch the saved schedule between active and paused. Active runs and history are unchanged.'],
    archive: ['Archive schedule', 'Archive', 'Disable future runs and move the schedule to the archive. Active runs and all history are retained.'],
    stop: ['Stop run', 'Stop', 'Request native cancellation and wait for termination. No force-kill or arbitrary PID killing.'],
    delete: ['Delete run permanently', 'Delete', 'Permanently delete this run, its conversation and owned files. This cannot be undone.'],
  };
  const action = actions[request.action]; if (!action) throw new Error('Unknown Fire action');
  const review: ActionReview = { title: action[0], approve: action[1], danger: request.action === 'delete', fields: [], nextRuns: [], paused: false, effect: action[2] };
  const scheduled = request.action === 'save';
  const id = scheduled ? request.config?.id : request.id;
  if (id) review.fields.push([['stop', 'delete'].includes(request.action) ? 'Run ID' : 'Schedule ID', String(id)]);
  if (scheduled || (request.action === 'run' && !id)) {
    // Use the host's defaults/validation, without reading or changing the target folder.
    const config = validateConfig(request.config, scheduled, false);
    if (scheduled) {
      review.paused = !config.enabled;
      review.fields.push(['Name', config.name], ['State', config.enabled ? 'Active · automatic runs enabled' : 'Paused · no automatic runs'], ['Cron', config.cron], ['Timezone', timezone], ['Overlap', config.overlap === 'parallel' ? 'Allow parallel runs' : 'Skip while a prior run is unfinished']);
      review.nextRuns = cronPreview(config.cron, now, timezone).map((value: string) => date(Date.parse(value), timezone));
    }
    review.fields.push(['Mode', config.mode === 'run-worktree' ? 'Disposable worktree' : 'Current folder'], ['Folder', config.cwd], ['Model', config.model ? `${config.model.provider}/${config.model.id}` : 'Pi defaults at execution']);
    if (config.model) review.fields.push(['Thinking', config.thinking]);
    if (config.mode === 'run-worktree') {
      review.fields.push(['Remote', config.remote], ['Base', config.base || 'Remote default branch']);
      review.warning = disposal;
    } else if (!scheduled || config.overlap === 'parallel') review.warning = 'Concurrent runs may modify the same folder. Fire does not lock shared files.';
    review.prompt = config.prompt;
  }
  if (request.action === 'run' && id) review.warning = 'The saved mode and prompt are used at execution. A disposable worktree discards dirty, staged, untracked and ignored files after verified termination.';
  if (request.action === 'stop') review.warning = 'A disposable worktree is cleaned after verified termination; its local files are discarded. Shared-folder files are not removed.';
  if (request.action === 'delete') review.warning = 'Residual worktree cleanup requires verified ownership and one explicit attempt, including dirty, staged, untracked and ignored files. Cleanup failure retains evidence. Remote PRs and external artifacts are not deleted.';
  return review;
}

export class FireActionReview {
  scroll = 0;
  maxScroll = 0;
  pageSize = 1;
  width = 0;
  closed = false;
  private cache?: { width: number; lines: string[] };
  constructor(public tui: any, public theme: Theme, public review: ActionReview, public done: (accepted: boolean) => void) {}
  invalidate() { this.cache = undefined; }
  dispose() { this.closed = true; }
  finish(accepted: boolean) { if (!this.closed) { this.closed = true; this.done(accepted); } }
  content(width: number) {
    if (this.cache?.width === width) return this.cache.lines;
    const wrap = (text: string, size: number, tone: Parameters<Theme['fg']>[0] = 'text') => wrapTextWithAnsi(this.theme.fg(tone, safe(text).replaceAll('\t', '    ')), Math.max(1, size));
    const section = (text: string) => this.theme.fg('accent', this.theme.bold(text));
    const columns = width >= 90 && this.review.prompt !== undefined;
    const leftWidth = columns ? Math.floor((width - 3) * .47) : width;
    const summary = [section('Settings'), ''];
    for (const [label, value] of this.review.fields) {
      if (leftWidth >= 40) {
        const lines = wrap(value, leftWidth - 11);
        summary.push(...lines.map((line, i) => (i ? ' '.repeat(11) : this.theme.fg('muted', fit(label, 11))) + line));
      } else summary.push(this.theme.fg('muted', label), ...wrap(value, leftWidth - 2).map(line => '  ' + line));
    }
    if (this.review.nextRuns.length) summary.push('', section(this.review.paused ? 'If enabled · preview' : 'Next runs · preview'), ...this.review.nextRuns.flatMap(value => wrap(value, leftWidth, 'muted')));
    summary.push('', section('What happens'), ...wrap(this.review.effect, leftWidth));
    if (this.review.warning) summary.push('', ...wrap(this.review.warning, leftWidth, this.review.danger ? 'error' : 'warning'));
    let lines = summary;
    if (this.review.prompt !== undefined) {
      const rightWidth = columns ? width - leftWidth - 3 : width;
      const prompt = [section('Prompt · full task'), '', ...wrap(this.review.prompt, rightWidth - 2).map(line => this.theme.fg('borderMuted', '│ ') + line)];
      lines = columns ? Array.from({ length: Math.max(summary.length, prompt.length) }, (_, i) => fit(summary[i] || '', leftWidth) + this.theme.fg('borderMuted', ' │ ') + fit(prompt[i] || '', rightWidth)) : [...summary, '', ...prompt];
    }
    this.cache = { width, lines }; return lines;
  }
  render(width: number) {
    this.width = width; const rows = this.tui.terminal.rows;
    if (width < 24 || rows < 14) return ['Fire · Review', 'Needs 24 × 14', 'Esc cancel'].map(line => fit(line, width));
    const lines = this.content(width - 4);
    const height = Math.min(rows - 2, lines.length + 7); this.pageSize = height - 7;
    this.maxScroll = Math.max(0, lines.length - this.pageSize); this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll));
    const tone = this.review.danger ? 'error' : 'accent';
    const title = this.theme.fg(tone, this.theme.bold(`Fire · ${width < 40 ? this.review.approve : this.review.title}`));
    const position = this.maxScroll ? `${this.scroll + 1}–${Math.min(lines.length, this.scroll + this.pageSize)}/${lines.length} · ↑↓ / PgDn` : this.review.danger ? 'Irreversible · no automatic retry' : 'No changes until confirmed';
    const buttons = width < 40 ? this.theme.fg(tone, 'Enter yes · Esc no') : this.theme.bg('selectedBg', this.theme.fg(tone, this.theme.bold(` Enter ${this.review.approve} `))) + this.theme.fg('muted', '  Esc cancel');
    return fireFrame(this.theme, title, lines.slice(this.scroll, this.scroll + this.pageSize).map(line => ' ' + line), width, height, [this.theme.fg(this.review.danger ? 'error' : 'dim', position), buttons]);
  }
  handleInput(data: string) {
    if (this.closed) return;
    if (matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) { this.finish(false); return; }
    if (this.width < 24 || this.tui.terminal.rows < 14) return;
    if (matchesKey(data, 'enter')) { this.finish(true); return; }
    if (matchesKey(data, 'home')) this.scroll = 0;
    else if (matchesKey(data, 'end')) this.scroll = this.maxScroll;
    else if (matchesKey(data, 'up') || data === 'k') this.scroll--;
    else if (matchesKey(data, 'down') || data === 'j') this.scroll++;
    else if (matchesKey(data, 'pageUp')) this.scroll -= this.pageSize;
    else if (matchesKey(data, 'pageDown') || data === ' ') this.scroll += this.pageSize;
    this.scroll = Math.max(0, Math.min(this.scroll, this.maxScroll)); this.tui.requestRender();
  }
}

async function confirmFireAction(ctx: ExtensionContext, request: any, signal?: AbortSignal) {
  if (signal?.aborted) return false;
  const review = buildFireActionReview(request);
  let view: FireActionReview | undefined;
  const abort = () => view?.finish(false);
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const accepted = await ctx.ui.custom<boolean>((tui, theme, _keys, done) => {
      view = new FireActionReview(tui, theme, review, done);
      if (signal?.aborted) queueMicrotask(abort);
      return view;
    }, { overlay: true, overlayOptions: { width: '95%', maxHeight: '100%', anchor: 'center', margin: 1 } });
    return accepted === true && !signal?.aborted;
  } finally { signal?.removeEventListener('abort', abort); }
}

export class FirePromptComposer {
  editor: Editor;
  private autocomplete: AutocompleteProvider;
  busy = false;
  closed = false;
  error?: string;
  width = 80;
  constructor(public tui: any, public theme: Theme, public mode: string, public cwd: string, provider: AutocompleteProvider, public submit: (prompt: string) => Promise<boolean>, public done: () => void, public reportError: (message: string) => void) {
    this.editor = new Editor(tui, editorTheme(() => this.theme), { autocompleteMaxVisible: 3 });
    this.editor.disableSubmit = true;
    this.autocomplete = firePromptAutocomplete(provider);
    this.editor.setAutocompleteProvider(this.autocomplete);
  }
  get focused() { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; }
  invalidate() { this.editor.invalidate(); }
  dispose() { this.closed = true; this.editor.setAutocompleteProvider(this.autocomplete); }
  async send() {
    if (this.busy || this.closed) return;
    const prompt = this.editor.getExpandedText().trim();
    if (!prompt) { this.error = 'Write a task prompt first.'; this.tui.requestRender(); return; }
    this.busy = true; this.error = undefined; this.tui.requestRender();
    try { if (await this.submit(prompt)) { this.dispose(); this.done(); } }
    catch (e) { this.error = stringError(e); this.reportError(this.error); }
    finally { this.busy = false; if (!this.closed) this.tui.requestRender(); }
  }
  handleInput(data: string) {
    if (this.busy || this.closed) return;
    if ((matchesKey(data, 'escape') || matchesKey(data, 'ctrl+c')) && !this.editor.isShowingAutocomplete()) { this.dispose(); this.done(); return; }
    if (this.width < 24 || this.tui.terminal.rows < 14) return;
    if (matchesKey(data, 'ctrl+s')) { void this.send(); return; }
    this.editor.handleInput(matchesKey(data, 'enter') && !this.editor.isShowingAutocomplete() ? '\n' : data);
    this.tui.requestRender();
  }
  render(width: number): string[] {
    this.width = width;
    const rows = this.tui.terminal.rows;
    if (width < 24 || rows < 14) return ['Fire · Task composer', 'Needs 24 columns × 14 rows.', 'Esc cancel'].map(line => fit(line, width));
    const compact = rows < 20 && this.editor.isShowingAutocomplete();
    const header = [this.theme.fg('accent', this.theme.bold(`Fire · ${this.mode} · New task`)), ...(compact ? [] : [this.theme.fg('muted', safe(this.cwd)), ...(this.mode === 'run-worktree' ? [this.theme.fg('warning', width < 70 ? 'Cleanup deletes files' : 'Cleanup deletes dirty, staged, untracked and ignored worktree files')] : [])])];
    const footer = [this.theme.fg('accent', this.busy ? 'Submitting…' : width < 52 ? 'Ctrl+S run · Esc cancel' : 'Ctrl+S run · Enter newline · Esc cancel'), ...(compact ? [] : [this.theme.fg('dim', '/skill:name · @file · Tab complete')]), this.theme.fg(this.error ? 'error' : 'dim', this.error ? singleLine(this.error) : compact ? 'Enter newline · Tab pick' : 'Fresh session · no current conversation')];
    const available = Math.max(1, rows - 2 - header.length - footer.length);
    const lines = this.editor.render(width);
    const cursor = lines.findIndex(line => line.includes(CURSOR_MARKER));
    const start = Math.max(0, Math.min(cursor, lines.length - available));
    return [...header, ...lines.slice(start, start + available), ...footer].map(line => fit(line, width));
  }
}

export class FireView {
  snapshot: Snapshot = { schedules: [], runs: [] };
  status = 'Connecting…';
  notice?: { tone: 'error' | 'success' | 'warning'; text: string };
  connectionError?: string;
  conversationError?: string;
  conversationWarning?: string;
  refreshing = false;
  refreshVersion = 0;
  helpOpen = false;
  modalScroll = 0;
  maxModalScroll = 0;
  detailHeight = 1;
  maxDetailScroll = 0;
  listPageSize = 1;
  renderWidth = 80;
  closed = false;
  busy = false;
  timer?: ReturnType<typeof setInterval>;
  draft?: Config;
  fields: string[] = [];
  field = 0;
  input = new Input();
  editor: Editor;
  private promptAutocomplete: AutocompleteProvider;
  editing = false;
  confirmation?: { title: string; text: string; action: () => Promise<void>; danger: boolean };
  transcript: unknown[] = [];
  transcriptId?: string;
  overlay?: { setHidden(hidden: boolean): void; focus(): void };
  private _focused = false;
  constructor(public tui: any, public theme: Theme, public keybindings: any, public done: () => void, public ctx: ExtensionContext, public state: ViewState, public call: (request: object) => Promise<any>, provider?: AutocompleteProvider) {
    this.state.pane = 0;
    const base = firePromptAutocomplete(provider || new CombinedAutocompleteProvider([], ctx.cwd));
    this.promptAutocomplete = { ...base, getSuggestions: async (lines, line, col, options) => {
      // Pi's native file provider belongs to ctx.cwd, not an arbitrary schedule folder.
      // Do not offer misleading relative file paths when the schedule targets another folder.
      const before = (lines[line] || '').slice(0, col);
      if (this.draft?.cwd !== ctx.cwd && (options.force || !/^\/\S*$/.test(before))) return null;
      return base.getSuggestions(lines, line, col, options);
    } };
    this.editor = new Editor(tui, editorTheme(() => this.theme), { autocompleteMaxVisible: 3 });
    this.editor.disableSubmit = true;
    this.editor.setAutocompleteProvider(this.promptAutocomplete);
    void this.refresh();
    // ponytail: full snapshots suit personal history; add pagination only after measured refresh latency warrants it.
    this.timer = setInterval(() => { if (!this.busy) void this.refresh(); }, 2000);
  }
  get focused() { return this._focused; }
  set focused(value: boolean) { this._focused = value; this.focusInput(); }
  focusInput() { this.input.focused = this._focused && this.editing && this.fields[this.field] !== 'prompt'; this.editor.focused = this._focused && this.editing && this.fields[this.field] === 'prompt'; }
  invalidate() { this.input.invalidate(); this.editor.invalidate(); }
  dispose() { this.closed = true; clearInterval(this.timer); this.editor.setAutocompleteProvider(this.promptAutocomplete); }
  buckets() {
    const archived = this.snapshot.schedules.filter(s => s.archived).map(s => ({ id: s.id, name: s.name }));
    return [{ id: 'once', name: 'One-off runs' }, ...this.snapshot.schedules.filter(s => !s.archived).map(s => ({ id: s.id, name: s.name })), ...(archived.length ? [{ id: 'archive', name: 'Archived schedules' }] : []), ...archived];
  }
  schedule() { return this.snapshot.schedules.find(s => s.id === this.state.bucket); }
  runs() { return this.snapshot.runs.filter(r => this.state.bucket === 'once' ? !r.scheduleId : this.state.bucket === 'archive' ? this.snapshot.schedules.some(s => s.archived && s.id === r.scheduleId) : r.scheduleId === this.state.bucket); }
  selectedRun() { const runs = this.runs(); return runs.find(r => r.id === this.state.runId) || runs[0]; }
  async refresh() {
    if (this.closed) return;
    const version = ++this.refreshVersion;
    this.refreshing = true;
    try {
      const snapshot = await this.call({ action: 'list' });
      if (this.closed || version !== this.refreshVersion) return;
      this.snapshot = { ...snapshot, connected: true };
      this.connectionError = undefined;
      if (!this.buckets().some(b => b.id === this.state.bucket)) this.state.bucket = 'once';
      const run = this.selectedRun(); this.state.runId = run?.id;
      this.status = `${this.snapshot.timezone || 'Mac timezone'} · Read-only history · may contain secrets`;
      this.conversationError = undefined;
      this.conversationWarning = undefined;
      if (run) {
        try {
          const response = await this.call({ action: 'conversation', id: run.id });
          if (!this.closed && version === this.refreshVersion && this.selectedRun()?.id === run.id) {
            this.transcript = response.entries; this.transcriptId = run.id; this.conversationWarning = response.warning;
          }
        } catch (e) {
          if (version === this.refreshVersion && this.selectedRun()?.id === run.id) this.conversationError = stringError(e);
        }
      }
    } catch (e) {
      if (this.closed || version !== this.refreshVersion) return;
      this.snapshot.connected = false;
      this.connectionError = stringError(e);
      this.status = 'Disconnected · g reconnect · a activate';
    } finally {
      if (!this.closed && version === this.refreshVersion) { this.refreshing = false; this.tui.requestRender(); }
    }
  }
  async perform(action: () => Promise<void>) {
    if (this.busy) return;
    this.busy = true; this.notice = undefined; this.tui.requestRender();
    try { await action(); await this.refresh(); }
    catch (e) { this.notice = { tone: 'error', text: stringError(e) }; }
    finally { this.busy = false; this.focusInput(); if (!this.closed) this.tui.requestRender(); }
  }
  confirm(text: string, action: () => Promise<void>, title = 'Review action', danger = false) {
    this.confirmation = { text, action, title, danger }; this.modalScroll = 0;
    this.editor.setAutocompleteProvider(this.promptAutocomplete);
    this.input.focused = false; this.editor.focused = false;
  }
  async nativeDialog<T>(dialog: () => Promise<T>): Promise<T> {
    this.overlay?.setHidden(true);
    try { return await dialog(); }
    finally { if (!this.closed) { this.overlay?.setHidden(false); this.overlay?.focus(); this.tui.requestRender(); } }
  }
  async mutation(action: string, id: string) {
    const manualCleanupVerified = action === 'delete' ? await this.nativeDialog(() => reconcileDeletion(this.ctx, this.snapshot.runs.find(r => r.id === id))) : false;
    if (manualCleanupVerified === undefined) return;
    await this.call({ action, id, manualCleanupVerified });
    this.notice = { tone: 'success', text: `${action === 'run' ? 'Run accepted' : action === 'stop' ? 'Stop requested' : action === 'delete' ? 'Run permanently deleted' : action === 'archive' ? 'Schedule archived; history retained' : 'Schedule updated'} · ${id.slice(0, 8)}` };
  }
  openForm(existing?: Schedule) {
    this.draft = { name: '', cwd: this.ctx.cwd, mode: 'run', cron: '0 13 * * 1-5', enabled: true, overlap: 'skip', prompt: '', ...existing };
    this.field = 0; this.editing = true; this.notice = undefined; this.updateFields(); this.loadField();
  }
  updateFields() { this.fields = ['name', 'cwd', 'mode', 'cron', 'enabled', 'overlap', ...(this.draft?.mode === 'run-worktree' ? ['remote', 'base'] : []), 'prompt']; }
  loadField() {
    this.editor.setAutocompleteProvider(this.promptAutocomplete);
    const key = this.fields[this.field];
    this.input.setValue(String((this.draft as any)?.[key] ?? ''));
    if (key === 'prompt') this.editor.setText(this.draft?.prompt || '');
    this.focusInput();
  }
  saveField() {
    if (!this.draft) return;
    const key = this.fields[this.field];
    if (!['mode', 'enabled', 'overlap'].includes(key)) (this.draft as any)[key] = key === 'prompt' ? this.editor.getExpandedText() : this.input.getValue();
  }
  preview() { try { return cronPreview(this.draft?.cron || '', new Date(), this.snapshot.timezone).map((s: string) => date(new Date(s).getTime(), this.snapshot.timezone)); } catch (e) { return [stringError(e)]; } }
  scrollKey() { return `${this.state.bucket}:${this.selectedRun()?.id}:${this.state.tab}`; }
  badge(run: Run) {
    const label = runLabel(run).toLowerCase();
    if (label === 'manual') return this.theme.fg('warning', '! MANUAL');
    if (label === 'error') return this.theme.fg('error', '✗ Error');
    if (label === 'blocked') return this.theme.fg('warning', '■ Blocked');
    if (label === 'skipped') return this.theme.fg('dim', '○ Skipped');
    if (run.runtime === 'preparing') return this.theme.fg('accent', '○ Preparing');
    if (run.runtime === 'running') return this.theme.fg('accent', run.stopRequested ? '■ Stopping' : '● Running');
    if (['pending', 'removing'].includes(run.cleanup)) return this.theme.fg('accent', '● Cleaning');
    return this.theme.fg('muted', run.stopRequested ? '■ Stopped' : '○ Ended');
  }
  section(title: string, width: number, active = false) {
    const label = truncateToWidth(` ${title} `, Math.max(0, width - 2), '…');
    return this.theme.fg(active ? 'borderAccent' : 'borderMuted', '─') + this.theme.fg(active ? 'accent' : 'muted', label) + this.theme.fg('borderMuted', '─'.repeat(Math.max(0, width - visibleWidth(label) - 1)));
  }
  selectedLine(text: string, width: number, selected: boolean, active: boolean) {
    const line = fit(text, width);
    return selected && active ? this.theme.bg('selectedBg', line) : line;
  }
  frame(title: string, body: string[], width: number, height: number, footer: string[]) { return fireFrame(this.theme, title, body, width, height, footer); }
  markdown(text: string, width: number) {
    const fg = (token: Parameters<Theme['fg']>[0]) => (s: string) => this.theme.fg(token, s);
    // Like the subagents selector, use the injected theme: jiti's module-global theme may be unset.
    return new Markdown(safe(text), 0, 0, {
      heading: fg('mdHeading'), link: fg('mdLink'), linkUrl: fg('mdLinkUrl'), code: fg('mdCode'), codeBlock: fg('mdCodeBlock'), codeBlockBorder: fg('mdCodeBlockBorder'), quote: fg('mdQuote'), quoteBorder: fg('mdQuoteBorder'), hr: fg('mdHr'), listBullet: fg('mdListBullet'),
      bold: s => this.theme.bold(s), italic: s => this.theme.italic(s), strikethrough: s => this.theme.strikethrough(s), underline: s => this.theme.underline(s),
    }).render(Math.max(1, width));
  }
  conversationLines(width = 80) {
    const run = this.selectedRun();
    const output: string[] = [];
    const wrap = (text: string) => wrapTextWithAnsi(text, Math.max(1, width));
    if (this.conversationError) output.push(...wrap(this.theme.fg('error', `Conversation unavailable: ${safe(this.conversationError)} · g retry`)), '');
    if (this.conversationWarning) output.push(...wrap(this.theme.fg('warning', safe(this.conversationWarning))), '');
    if (!run || this.transcriptId !== run.id) return output.length ? output : [this.theme.fg('dim', 'Loading conversation…')];
    const rail = (text: string, markdown = false, color: Parameters<Theme['fg']>[0] = 'text') => {
      const lines = markdown ? this.markdown(text, width - 2) : wrapTextWithAnsi(this.theme.fg(color, safe(text)), Math.max(1, width - 2));
      output.push(...lines.map(line => this.theme.fg('borderMuted', '│ ') + line));
    };
    for (const raw of this.transcript) {
      const entry = raw as any;
      if (entry.type === 'custom') {
        output.push(this.theme.fg('customMessageLabel', `◇ ${singleLine(entry.customType)}${this.state.expanded ? '' : ' · metadata folded'}`));
        if (this.state.expanded) rail(JSON.stringify(entry.data, null, 2), false, 'muted');
        output.push(''); continue;
      }
      if (entry.type === 'compaction' || entry.type === 'branch_summary') { output.push(this.theme.fg('dim', '◇ Session summary')); rail(entry.summary); output.push(''); continue; }
      const message = entry.type === 'message' ? entry.message : entry.type === 'custom_message' ? { ...entry, role: 'custom' } : null;
      if (!message || message.role === 'system') continue;
      if (message.role === 'toolResult') {
        output.push(this.theme.fg(message.isError ? 'error' : 'toolTitle', `├─ ${message.isError ? '✗' : '✓'} ${singleLine(message.toolName)}${this.state.expanded ? '' : ' · output folded'}`));
        if (!this.state.expanded) continue;
      } else {
        const label = message.role === 'assistant' ? '◆ Assistant' : message.role === 'user' ? '◇ User' : message.role === 'bashExecution' ? '├─ Bash' : `◇ ${singleLine(message.customType || message.role)}`;
        output.push(this.theme.fg(message.role === 'user' ? 'warning' : 'accent', this.theme.bold(label)));
      }
      if (typeof message.content === 'string') rail(message.content, message.role === 'assistant');
      else for (const block of message.content || []) {
        if (block.type === 'thinking') rail(this.state.expanded ? block.thinking : 'Thinking folded · o expand', false, 'thinkingText');
        else if (block.type === 'toolCall') { rail(`→ ${block.name}${this.state.expanded ? '\n' + JSON.stringify(block.arguments, null, 2) : ' · arguments folded'}`, false, 'toolTitle'); }
        else if (block.type === 'text') rail(block.text, message.role === 'assistant', message.isError ? 'error' : 'text');
        else rail(`[${block.type}]`, false, 'dim');
      }
      if (message.role === 'bashExecution') rail(this.state.expanded ? message.output || '' : 'Output folded · o expand', false, 'toolOutput');
      output.push('');
    }
    return output.length ? output : [this.theme.fg('dim', 'No persisted conversation yet.')];
  }
  detailLines(width = 80) {
    const run = this.selectedRun(); if (!run) return this.emptyLines(width);
    const lines: string[] = [];
    const text = (value: unknown, color: Parameters<Theme['fg']>[0] = 'text') => lines.push(...wrapTextWithAnsi(this.theme.fg(color, safe(value)), Math.max(1, width)));
    const field = (label: string, value: unknown) => {
      const prefix = fit(this.theme.fg('muted', label), Math.min(14, Math.floor(width / 3)));
      const values = wrapTextWithAnsi(safe(value ?? '—'), Math.max(1, width - visibleWidth(prefix) - 1));
      values.forEach((value, i) => lines.push((i ? ' '.repeat(visibleWidth(prefix)) : prefix) + ' ' + value));
    };
    const heading = (title: string) => { if (lines.length) lines.push(''); lines.push(this.theme.fg('accent', this.theme.bold(title))); };
    if (run.manual) { heading('! Manual action required'); text(run.manual, 'warning'); text('Evidence retained. No automatic cleanup retry.', 'muted'); }
    if (run.error) { heading('Execution error'); text(run.error, 'error'); }
    if (run.blocked) { heading('Human input unavailable'); text(run.blocked, 'warning'); }
    if (run.skipped) text(run.skipped, 'muted');
    if (this.state.tab === 0) {
      if (run.result) { heading('Assistant response'); lines.push(...this.markdown(run.result, width)); }
      if (lines.length) lines.push('', this.section('Conversation · read-only', width), '');
      return [...lines, ...this.conversationLines(width)];
    }
    const model = run.actualModel as { provider?: string; id?: string } | undefined;
    const wt = run.worktree as Record<string, unknown> | undefined;
    const usage = run.usage as { tokens?: Record<string, number>; cost?: number; toolCalls?: number; totalMessages?: number } | undefined;
    heading('Execution');
    field('Run', run.id); field('Result', runLabel(run)); field('Process', run.runtime); field('Mode', run.config.mode); field('Started', date(run.startedAt, run.timezone as string | undefined)); field('Ended', date(run.endedAt, run.timezone as string | undefined)); field('Elapsed', duration(run)); field('Timezone', run.timezone);
    field('Model', model ? `${model.provider}/${model.id}` : 'Not reported'); field('Thinking', run.actualThinking ?? 'Not reported');
    field('Source', run.config.cwd); field('Run folder', run.executionCwd);
    if (run.workerError) field('Worker note', run.workerError);
    heading('Worktree & Git'); field('Cleanup', run.cleanup);
    if (wt) { for (const [key, label] of [['remote', 'Remote'], ['base', 'Base branch'], ['baseCommit', 'Base commit'], ['branch', 'Run branch'], ['finalCommit', 'Final commit'], ['path', 'Worktree'], ['removalResult', 'Removal result']]) if (wt[key] !== undefined) field(label, wt[key]); }
    else text(run.config.mode === 'run' ? 'Shared folder · Fire does not remove files.' : 'No worktree metadata reported.', 'muted');
    for (const url of (run.observedPrUrls as string[] || [])) field('Observed PR', url);
    heading('Usage · reported, not an invoice');
    if (usage) { for (const [key, value] of Object.entries(usage.tokens || {})) field(`${key} tokens`, value.toLocaleString()); field('Cost', typeof usage.cost === 'number' ? `$${usage.cost.toFixed(4)}` : 'Not reported'); field('Tool calls', usage.toolCalls); field('Messages', usage.totalMessages); }
    else text('Not reported yet.', 'dim');
    heading('Session & history'); field('Session', run.sessionFile ?? run.sessionDir); text('Read-only · retained until permanent deletion. May contain secrets.', 'muted');
    heading('Task · execution-time settings'); field('Schedule', run.config.name || 'One-off'); field('Cron', run.config.cron || 'Immediate'); field('Overlap', run.config.overlap || 'Independent'); lines.push(''); text(run.config.prompt);
    return lines;
  }
  emptyLines(width: number) {
    const offline = this.snapshot.connected === false;
    const title = offline ? '○ Fire is disconnected' : this.snapshot.connected === undefined ? 'Connecting to Fire…' : 'No runs yet';
    const hint = offline ? 'Press g to reconnect, or a to activate the host. Existing history is not removed.' : this.schedule() ? 'Press r to run this schedule now. Future runs appear here automatically.' : this.state.bucket === 'archive' ? 'Archived schedules keep their past conversations here.' : 'Use /fire run <prompt> for a one-off task, or n to create a schedule.';
    return ['', this.theme.fg(offline ? 'warning' : 'muted', this.theme.bold(title)), '', ...wrapTextWithAnsi(this.theme.fg('dim', hint), Math.max(1, width)), ...(offline && this.connectionError ? ['', ...wrapTextWithAnsi(this.theme.fg('dim', safe(this.connectionError)), Math.max(1, width))] : [])];
  }
  scheduleLines(width: number, height: number) {
    const buckets = this.buckets(); const selected = buckets.findIndex(b => b.id === this.state.bucket);
    const capacity = Math.max(1, Math.floor((height - 2) / 2));
    if (this.state.pane === 0) this.listPageSize = capacity;
    const start = Math.max(0, Math.min(selected - capacity + 1, buckets.length - capacity));
    const lines = [this.section('Schedules', width, this.state.pane === 0)];
    for (const bucket of buckets.slice(start, start + capacity)) {
      const s = this.snapshot.schedules.find(s => s.id === bucket.id);
      const count = this.snapshot.runs.filter(r => bucket.id === 'once' ? !r.scheduleId : bucket.id === 'archive' ? this.snapshot.schedules.some(s => s.archived && s.id === r.scheduleId) : r.scheduleId === bucket.id).length;
      const selected = bucket.id === this.state.bucket;
      const glyph = s ? s.archived ? '○' : s.enabled ? '●' : 'Ⅱ' : '◇';
      const color = s?.archived ? 'dim' : s && !s.enabled ? 'warning' : 'accent';
      const title = `${selected ? this.theme.fg('accent', '›') : ' '} ${this.theme.fg(color, glyph)} ${selected ? this.theme.bold(singleLine(bucket.name)) : singleLine(bucket.name)}`;
      lines.push(this.selectedLine(pair(title, this.theme.fg('dim', String(count)), width), width, selected, this.state.pane === 0));
      const detail = s ? s.archived ? 'Archived · history retained' : !s.enabled ? 'Paused · manual run available' : s.next ? `Next ${shortDate(s.next)}` : 'Next run pending' : bucket.id === 'once' ? 'Independent background tasks' : 'Past schedules & conversations';
      lines.push(this.selectedLine('    ' + this.theme.fg('dim', detail), width, selected, this.state.pane === 0));
    }
    if (buckets.length > capacity) lines.push(this.theme.fg('dim', ` ${selected + 1}/${buckets.length} · ↑↓ more`));
    return lines;
  }
  historyLines(width: number, height: number) {
    const s = this.schedule(); const runs = this.runs(); const selected = runs.findIndex(r => r.id === this.selectedRun()?.id);
    const title = s?.name || (this.state.bucket === 'once' ? 'One-off runs' : 'Archived schedules');
    const context = s ? `${s.mode} · ${s.cron} · ${s.overlap}` : 'Independent sessions · newest first';
    const lines = [pair(' ' + this.theme.bold(singleLine(title)), this.theme.fg('muted', s?.archived ? 'Archived' : s ? s.enabled ? 'Active' : 'Paused' : ''), width), fit(' ' + this.theme.fg('dim', context), width), this.section(`History · ${runs.length} ${runs.length === 1 ? 'run' : 'runs'}`, width, this.state.pane === 1)];
    if (!runs.length) return [...lines, ...this.emptyLines(width - 2).map(s => ' ' + s)].slice(0, height);
    const capacity = Math.max(1, Math.floor((height - lines.length) / 2));
    if (this.state.pane === 1) this.listPageSize = capacity;
    const start = Math.max(0, Math.min(selected - capacity + 1, runs.length - capacity));
    for (const run of runs.slice(start, start + capacity)) {
      const current = run.id === this.selectedRun()?.id;
      const left = `${current ? this.theme.fg('accent', '›') : ' '} ${this.theme.fg('muted', shortDate(run.startedAt))}`;
      const summary = this.theme.fg(current ? 'text' : 'dim', singleLine(run.manual || run.error || run.blocked || run.result || run.skipped || run.config.prompt));
      const compact = width < 48;
      const title = compact ? pair(`${current ? '›' : ' '} ${this.badge(run)}`, this.theme.fg('dim', duration(run)), width) : pair(left, `${this.badge(run)} ${this.theme.fg('dim', duration(run))}`, width);
      lines.push(this.selectedLine(title, width, current, this.state.pane === 1));
      lines.push(this.selectedLine(`  ${compact ? this.theme.fg('muted', shortDate(run.startedAt)) + ' · ' : ''}${summary}`, width, current, this.state.pane === 1));
    }
    return lines;
  }
  detailPanel(width: number, height: number) {
    const tab = (label: string, index: number) => this.state.tab === index ? this.theme.fg('accent', this.theme.bold(`[${label}]`)) : this.theme.fg('muted', label);
    const title = width < 36 ? `${this.state.tab ? 'Environment' : 'Conversation'} · i switch` : `${tab('Conversation', 0)}  ${tab('Environment', 1)}`;
    const header = [this.section(title, width, this.state.pane === 2)];
    const run = this.selectedRun();
    if (run && height >= 5) header.push(...wrapTextWithAnsi(this.theme.fg('muted', `Result ${runLabel(run)} · Process ${run.runtime} · Cleanup ${run.cleanup}`), Math.max(1, width - 2)).slice(0, height - 4).map(s => ' ' + s));
    const details = this.detailLines(width - 2);
    this.detailHeight = Math.max(1, height - header.length - 1);
    this.maxDetailScroll = Math.max(0, details.length - this.detailHeight);
    const key = this.scrollKey(); const offset = Math.max(0, Math.min(this.state.scroll[key] || 0, this.maxDetailScroll));
    this.state.scroll[key] = offset;
    const lines = [...header, ...details.slice(offset, offset + this.detailHeight).map(line => ' ' + line)];
    while (lines.length < height - 1) lines.push('');
    lines.push(this.theme.fg('dim', ` ${details.length ? offset + 1 : 0}–${Math.min(details.length, offset + this.detailHeight)}/${details.length} · ${this.state.tab ? 'Read-only' : this.state.expanded ? 'Tools expanded' : 'Tools folded'}${offset < this.maxDetailScroll ? ' · ↓ more' : ''}`));
    return lines;
  }
  helpLines(width: number) {
    const sections = [
      ['Navigate', 'Tab / Shift+Tab  Next / previous pane', 'Focus keys: [1] Schedules · [2] History · [3] Detail', '↑↓ or j/k  Select or scroll', 'PgUp / PgDn  Page through the focused pane', 'Ctrl+U / Ctrl+D  Half-page scroll in Detail', 'Home / End  First / last item or line', 'Enter  Open the next pane', 'i  Conversation / environment', 'o  Expand / fold tools and thinking'],
      ['Schedules', 'n  New schedule', 'e  Edit schedule / resume folded draft', 'p  Pause / resume future runs', 'r  Run selected schedule now (confirmation)', 'd  Archive schedule; keep history (confirmation)'],
      ['Runs', 'x  Request native stop (confirmation)', 'Shift+D  Permanently delete selected run (confirmation)', 'No force-kill or automatic cleanup retry.'],
      ['Connection', 'g  Reconnect / refresh', 'a  Activate host (confirmation; may incur provider cost)', 'Esc  Close Fire; background runs continue'],
      ['Editor', 'Tab / Shift+Tab  Next / previous field', 'Space / Enter  Change a choice', 'Ctrl+S  Review and save', 'Esc  Fold draft; closing Fire discards it'],
    ];
    if (this.notice) sections.unshift(['Last action', this.notice.text]);
    if (this.connectionError) sections.unshift(['Connection error', this.connectionError]);
    return sections.flatMap(([title, ...items]) => [this.theme.fg('accent', this.theme.bold(title)), ...items.flatMap(s => wrapTextWithAnsi(safe(s), width)), '']);
  }
  renderModal(width: number, height: number) {
    const confirmation = this.confirmation;
    const title = confirmation ? this.theme.fg(confirmation.danger ? 'error' : 'warning', this.theme.bold(confirmation.title)) : this.theme.bold('Fire · Keyboard guide');
    const lines = confirmation ? wrapTextWithAnsi(safe(confirmation.text), width - 4) : this.helpLines(width - 4);
    height = Math.min(height, lines.length + 7);
    const capacity = height - 7;
    this.maxModalScroll = Math.max(0, lines.length - capacity);
    this.modalScroll = Math.max(0, Math.min(this.modalScroll, this.maxModalScroll));
    const body = lines.slice(this.modalScroll, this.modalScroll + capacity).map(line => ' ' + line);
    const position = this.maxModalScroll ? `${this.modalScroll + 1}–${Math.min(lines.length, this.modalScroll + capacity)}/${lines.length} · ↑↓ / PgDn` : confirmation?.danger ? 'Irreversible · no automatic retry' : 'No changes until confirmed';
    const footer = [this.theme.fg('dim', position), confirmation ? this.theme.fg('warning', width < 48 ? 'Enter yes · Esc cancel' : 'Enter confirm action · Esc cancel') : this.theme.fg('dim', 'Esc / ? back')];
    return this.frame(title, body, width, height, footer);
  }
  fieldValue(key: string) {
    const value = (this.draft as any)?.[key];
    if (key === 'enabled') return value ? 'Active' : 'Paused';
    if (key === 'overlap') return value === 'parallel' ? 'Parallel' : 'Skip overlapping';
    return singleLine(value) || (key === 'remote' ? 'origin (default)' : key === 'base' ? 'Remote default' : 'Not set');
  }
  renderForm(width: number, height: number) {
    const draft = this.draft!; const key = this.fields[this.field];
    const completing = key === 'prompt' && this.editor.isShowingAutocomplete();
    if (completing && height < 22) {
      // Keep both the cursor and the selected native suggestion visible on short terminals.
      const lines = this.editor.render(width); const available = height - 2;
      const cursor = lines.findIndex(line => line.includes(CURSOR_MARKER));
      const start = Math.max(0, Math.min(cursor, lines.length - available));
      return [this.theme.fg('accent', 'Fire · Prompt completion'), ...lines.slice(start, start + available), this.theme.fg('dim', 'Tab/Enter pick · Esc')].map(line => fit(line, width));
    }
    if (!completing) height = Math.min(height, this.fields.length * 2 + 9);
    const editHint = completing ? 'Tab/Enter pick · Esc dismiss · Ctrl+S save' : key === 'prompt' && width >= 65 ? 'Enter newline · Tab field · Ctrl+S save' : width < 48 ? 'Tab field · Ctrl+S save' : 'Tab / Shift+Tab field · Ctrl+S review & save';
    const footer = [this.theme.fg('accent', this.busy ? 'Saving schedule…' : editHint), this.theme.fg('dim', this.busy ? 'Esc fold · save continues' : this.notice?.tone === 'error' ? 'Esc fold · ? full error' : width < 48 ? 'Esc fold · close discards' : 'Esc fold draft · closing Fire discards unsaved changes'), this.notice ? this.theme.fg(this.notice.tone, singleLine(this.notice.text)) : this.theme.fg('dim', 'Pi defaults · Mac timezone · no inherited conversation')];
    const bodyHeight = height - footer.length - 5;
    const leftWidth = width >= 90 ? 29 : 0;
    const contentWidth = width - 4 - (leftWidth ? leftWidth + 1 : 0);
    const content: string[] = [this.theme.fg('accent', this.theme.bold(`${this.field + 1}/${this.fields.length}  ${fieldInfo[key][0]}`))];
    const value = ['mode', 'enabled', 'overlap'].includes(key) ? [this.theme.bg('selectedBg', fit(` ‹ ${this.fieldValue(key)} › `, contentWidth)), this.theme.fg('dim', 'Space / Enter to change')] : key === 'prompt' ? this.editor.render(contentWidth) : this.input.render(contentWidth);
    // Preserve the native cursor even on short terminals; never crop the editor from its first line.
    const available = Math.max(1, bodyHeight - 3);
    const cursor = value.findIndex(line => line.includes(CURSOR_MARKER));
    const start = Math.max(0, Math.min(completing ? cursor : cursor - available + 1, value.length - available));
    content.push('', ...value.slice(start, start + available));
    const fieldHint = key === 'prompt' && draft.cwd !== this.ctx.cwd ? 'Loaded Pi skills are available. For file completion, open Pi in this working folder.' : fieldInfo[key][1];
    const hint = wrapTextWithAnsi(this.theme.fg('muted', fieldHint), contentWidth);
    if (content.length + hint.length + 1 <= bodyHeight) content.push('', ...hint);
    const remaining = bodyHeight - content.length;
    if (remaining >= 4 && !completing) {
      content.push('', this.section(`Next runs · ${this.snapshot.timezone || 'Mac timezone'}`, contentWidth));
      content.push(...this.preview().slice(0, Math.min(5, remaining - 2)).map((s: string) => this.theme.fg('dim', `  ${s}`)));
    }
    const fields: string[] = [this.section(draft.id ? 'Edit schedule' : 'New schedule', leftWidth)];
    const capacity = Math.max(1, Math.floor((bodyHeight - 1) / 2));
    const first = Math.max(0, Math.min(this.field - capacity + 1, this.fields.length - capacity));
    for (const [index, name] of this.fields.entries()) {
      if (index < first || index >= first + capacity) continue;
      fields.push(this.selectedLine(`${index === this.field ? '›' : ' '} ${fieldInfo[name][0]}`, leftWidth, index === this.field, true));
      fields.push(this.selectedLine('  ' + this.theme.fg('dim', this.fieldValue(name)), leftWidth, index === this.field, true));
    }
    const body = Array.from({ length: bodyHeight }, (_, i) => leftWidth ? fit(fields[i] || '', leftWidth) + this.theme.fg('borderMuted', '│') + ' ' + fit(content[i] || '', contentWidth) + ' ' : ' ' + fit(content[i] || '', contentWidth));
    return this.frame(pair(this.theme.bold('Fire · Schedule editor'), this.theme.fg(this.busy ? 'accent' : 'warning', this.busy ? 'Saving…' : 'Unsaved draft'), width - 3), body, width, height, footer);
  }
  actionHints() {
    if (this.busy) return 'Working… · changes pending';
    if (!this.snapshot.connected) return this.renderWidth < 55 ? 'g retry · a activate' : 'g reconnect · a activate · ? help';
    if (this.draft) return 'e resume draft · n new · ? help';
    const schedule = this.schedule(); const run = this.selectedRun();
    if (this.state.pane === 0) return schedule && !schedule.archived ? `n new · e edit · p ${schedule.enabled ? 'pause' : 'resume'} · r run · d archive` : 'n new schedule · Enter history';
    if (this.state.pane === 1) return run ? `${run.runtime === 'running' || run.runtime === 'preparing' ? 'x stop' : run.runtime === 'unknown' ? 'MANUAL · inspect before acting' : 'Shift+D delete'} · Enter detail` : 'n new schedule · ? help';
    return `i ${this.state.tab ? 'conversation' : 'environment'} · o ${this.state.expanded ? 'fold' : 'expand'} tools · ↑↓ / Ctrl+U/D scroll`;
  }
  render(width: number): string[] {
    const rows = this.tui.terminal.rows;
    this.renderWidth = width;
    if (width < 24 || rows < 14) return ['Fire', 'Needs 24 columns × 14 rows.', 'Esc back / close'].map(line => fit(line, width));
    const height = rows - 2;
    if (this.confirmation || this.helpOpen) return this.renderModal(width, height);
    if (this.editing && this.draft) return this.renderForm(width, height);
    const connection = this.theme.fg(this.snapshot.connected ? 'success' : 'warning', this.snapshot.connected ? '● Connected' : this.snapshot.connected === false ? '○ Disconnected' : '○ Connecting');
    const pending = this.snapshot.runs.filter(r => r.runtime === 'running' || r.runtime === 'preparing').length;
    const title = pair(this.theme.bold('Fire') + (width >= 65 ? this.theme.fg('dim', ` · Background tasks${pending ? ` · ${pending} active` : ''}`) : ''), connection, width - 3);
    const notice = this.notice ? this.theme.fg(this.notice.tone, `${this.notice.tone === 'success' ? '✓ ' : '! '}${singleLine(this.notice.text)}`) : this.draft ? this.theme.fg('warning', 'Unsaved draft folded · e resume') : this.theme.fg('dim', this.status);
    const footer = [this.theme.fg('muted', this.actionHints()), this.theme.fg('dim', width < 40 ? 'Tab · ? help · Esc' : width < 80 ? 'Tab pane · ? keys · Esc close' : 'Tab / Shift+Tab pane · keys [1] [2] [3] · ? help · Esc close'), notice];
    const bodyHeight = height - footer.length - 5;
    const inner = width - 2;
    let body: string[];
    if (width >= 90 && bodyHeight >= 14) {
      const leftWidth = Math.max(26, Math.min(34, Math.floor((inner - 1) * .28)));
      const rightWidth = inner - leftWidth - 1;
      const historyHeight = 3 + Math.min(3, Math.max(1, Math.floor((bodyHeight - 9) / 2))) * 2;
      const left = this.scheduleLines(leftWidth, bodyHeight);
      const history = this.historyLines(rightWidth, historyHeight);
      while (history.length < historyHeight) history.push('');
      const right = this.runs().length ? [...history, ...this.detailPanel(rightWidth, bodyHeight - historyHeight)] : this.state.pane === 2 ? this.detailPanel(rightWidth, bodyHeight) : this.historyLines(rightWidth, bodyHeight);
      body = Array.from({ length: bodyHeight }, (_, i) => fit(left[i] || '', leftWidth) + this.theme.fg('borderMuted', '│') + fit(right[i] || '', rightWidth));
    } else {
      const names = width < 45 ? ['Sched', 'Runs', 'Detail'] : ['Schedules', 'History', 'Detail'];
      const tabs = names.map((name, i) => this.state.pane === i ? this.theme.fg('accent', this.theme.bold(`[${name}]`)) : this.theme.fg('dim', name)).join(width < 40 ? ' ' : ' · ');
      const pane = this.state.pane === 0 ? this.scheduleLines(inner, bodyHeight - 1) : this.state.pane === 1 ? this.historyLines(inner, bodyHeight - 1) : this.detailPanel(inner, bodyHeight - 1);
      body = [tabs, ...pane];
    }
    return this.frame(title, body, width, height, footer);
  }
  handleInput(data: string) {
    if (matchesKey(data, 'ctrl+c')) data = '\x1b';
    if ((this.busy || this.renderWidth < 24 || this.tui.terminal.rows < 14) && !matchesKey(data, 'escape')) return;
    if (this.confirmation || this.helpOpen) {
      if (matchesKey(data, 'escape') || (!this.confirmation && data === '?')) { this.confirmation = undefined; this.helpOpen = false; this.focusInput(); }
      else if (this.confirmation && matchesKey(data, 'enter')) { const action = this.confirmation.action; this.confirmation = undefined; void this.perform(action); }
      else if (matchesKey(data, 'home')) this.modalScroll = 0;
      else if (matchesKey(data, 'end')) this.modalScroll = this.maxModalScroll;
      else {
        const up = matchesKey(data, 'up') || matchesKey(data, 'pageUp') || data === 'k';
        const down = matchesKey(data, 'down') || matchesKey(data, 'pageDown') || data === 'j';
        if (up || down) this.modalScroll = Math.max(0, Math.min(this.maxModalScroll, this.modalScroll + (up ? -1 : 1) * (matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown') ? Math.max(1, this.tui.terminal.rows - 9) : 1)));
      }
      this.tui.requestRender(); return;
    }
    if (this.editing && this.draft) {
      if (this.fields[this.field] === 'prompt' && this.editor.isShowingAutocomplete() && (matchesKey(data, 'tab') || matchesKey(data, 'enter') || matchesKey(data, 'escape'))) {
        this.editor.handleInput(data); this.saveField(); this.tui.requestRender(); return;
      }
      if (matchesKey(data, 'escape')) { this.saveField(); this.editor.setAutocompleteProvider(this.promptAutocomplete); this.editing = false; this.focusInput(); }
      else if (matchesKey(data, 'ctrl+s')) {
        this.saveField();
        try {
          if (!this.draft.name.trim()) throw new Error('Name is required.');
          if (!this.draft.prompt.trim()) throw new Error('Prompt is required.');
          if (!this.draft.cwd.trim()) throw new Error('Working folder is required.');
          const next = cronPreview(this.draft.cron, new Date(), this.snapshot.timezone);
          const draft = structuredClone(this.draft);
          this.confirm(`Name: ${draft.name}\nMode: ${draft.mode}\nFolder: ${draft.cwd}\nSchedule: ${draft.enabled ? 'Active' : 'Paused'} · ${draft.overlap}\n\nNext runs:\n${next.map((s: string) => date(new Date(s).getTime(), this.snapshot.timezone)).join('\n')}\n\n${draft.mode === 'run-worktree' ? disposal : 'Same-folder concurrency is allowed.'}`, async () => {
            const saved = await this.call({ action: 'save', config: draft });
            this.state.bucket = saved.id; this.state.runId = undefined; this.state.pane = 0;
            this.draft = undefined; this.editing = false; this.focusInput();
            this.notice = { tone: 'success', text: `Schedule saved · ${draft.name}` };
          }, 'Save schedule');
        } catch (e) { this.notice = { tone: 'error', text: stringError(e) }; }
      } else if (matchesKey(data, 'tab') || matchesKey(data, 'shift+tab')) {
        this.saveField(); this.field = (this.field + (matchesKey(data, 'shift+tab') ? -1 : 1) + this.fields.length) % this.fields.length; this.loadField();
      } else {
        const key = this.fields[this.field];
        if (['mode', 'enabled', 'overlap'].includes(key)) {
          if (matchesKey(data, 'enter') || data === ' ') {
            if (key === 'mode') this.draft.mode = this.draft.mode === 'run' ? 'run-worktree' : 'run';
            if (key === 'enabled') this.draft.enabled = !this.draft.enabled;
            if (key === 'overlap') this.draft.overlap = this.draft.overlap === 'skip' ? 'parallel' : 'skip';
            this.updateFields();
          }
        } else if (key === 'prompt') this.editor.handleInput(matchesKey(data, 'enter') ? '\n' : data); else this.input.handleInput(data);
        this.saveField();
      }
      this.tui.requestRender(); return;
    }
    const halfPage = this.state.pane === 2 && (matchesKey(data, 'ctrl+u') || matchesKey(data, 'ctrl+d'));
    if (matchesKey(data, 'escape')) { this.dispose(); this.draft = undefined; this.done(); return; }
    if (matchesKey(data, 'tab') || matchesKey(data, 'enter')) this.state.pane = (this.state.pane + 1) % 3;
    else if (matchesKey(data, 'shift+tab')) this.state.pane = (this.state.pane + 2) % 3;
    else if (['1', '2', '3'].includes(data)) this.state.pane = Number(data) - 1;
    else if (data === '?') { this.helpOpen = true; this.modalScroll = 0; }
    else if (data === 'i') this.state.tab = 1 - this.state.tab;
    else if (data === 'o') this.state.expanded = !this.state.expanded;
    else if (data === 'g') void this.perform(() => this.refresh());
    else if (data === 'a') {
      void this.perform(async () => {
        const choice = await this.nativeDialog(() => this.ctx.ui.select('Activate user-wide Fire host', ['Start detached now', 'Start at macOS login (install LaunchAgent)', 'Cancel']));
        if (!choice || choice === 'Cancel') return;
        await activate(defaultRoot(), join(getPackageDir(), 'dist', 'cli.js'), choice.startsWith('Start at'));
        this.notice = { tone: 'success', text: 'Fire host activated' };
      });
    } else if (data === 'n') {
      if (this.draft) this.confirm('Discard the unsaved draft and start a new schedule? No saved schedule or run is affected.', async () => this.openForm(), 'Discard draft');
      else this.openForm();
    }
    else if (data === 'e') { if (this.draft) { this.editing = true; this.loadField(); } else if (this.schedule() && !this.schedule()?.archived) this.openForm(this.schedule()); }
    else if (['p', 'r', 'd'].includes(data)) {
      const s = this.schedule();
      if (!this.snapshot.connected) this.notice = { tone: 'warning', text: 'Host disconnected · g reconnect before changing schedules.' };
      else if (s && !s.archived) {
        const action = data === 'p' ? 'pause' : data === 'r' ? 'run' : 'archive';
        if (action === 'pause') void this.perform(() => this.mutation(action, s.id));
        else this.confirm(action === 'archive' ? `Archive ${s.name}?\n\nFuture runs stop. Active runs and all history remain available under Archived schedules.` : `Run ${s.name} now with Pi defaults?\n\n${s.mode === 'run-worktree' ? disposal : 'Same-folder concurrency allowed.'}`, () => this.mutation(action, s.id), action === 'archive' ? 'Archive schedule' : 'Run schedule now');
      }
    } else if (data === 'x' || data === 'D' || matchesKey(data, 'shift+d')) {
      const run = this.selectedRun();
      if (!this.snapshot.connected) this.notice = { tone: 'warning', text: 'Host disconnected · g reconnect before controlling runs.' };
      else if (run) this.confirm(data === 'x' ? `Run: ${run.id}\n\nNative cancellation is requested; no force/PID killing.\n\n${run.config.mode === 'run-worktree' ? disposal : 'Files in the shared folder are not removed.'}` : `Run: ${run.id}\n\nConversation and owned files cannot be recovered.\n\nAny verified residual worktree will be removed, including dirty, staged, untracked and ignored files, with one explicit cleanup attempt.\n\nCleanup or ownership failures retain evidence. No remote PR or external artifact deletion.`, () => this.mutation(data === 'x' ? 'stop' : 'delete', run.id), data === 'x' ? 'Stop run' : 'Permanently delete run', data !== 'x');
    } else if (halfPage || matchesKey(data, 'up') || matchesKey(data, 'down') || matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown') || matchesKey(data, 'home') || matchesKey(data, 'end') || data === 'j' || data === 'k') {
      const direction = matchesKey(data, 'ctrl+u') || matchesKey(data, 'up') || matchesKey(data, 'pageUp') || matchesKey(data, 'home') || data === 'k' ? -1 : 1;
      const edge = matchesKey(data, 'home') || matchesKey(data, 'end');
      const step = halfPage ? Math.max(1, Math.floor(this.detailHeight / 2)) : matchesKey(data, 'pageUp') || matchesKey(data, 'pageDown') ? this.state.pane === 2 ? this.detailHeight : this.listPageSize : 1;
      if (this.state.pane === 0) {
        const buckets = this.buckets(); const current = buckets.findIndex(b => b.id === this.state.bucket);
        this.state.selections ||= {}; const selected = this.selectedRun(); if (selected) this.state.selections[this.state.bucket] = selected.id;
        const next = edge ? direction < 0 ? 0 : buckets.length - 1 : Math.max(0, Math.min(buckets.length - 1, current + direction * step));
        this.state.bucket = buckets[next].id; this.state.runId = this.state.selections[this.state.bucket] || this.runs()[0]?.id; void this.refresh();
      } else if (this.state.pane === 1) {
        const runs = this.runs(); const index = runs.findIndex(r => r.id === this.selectedRun()?.id);
        const next = edge ? direction < 0 ? 0 : runs.length - 1 : Math.max(0, Math.min(runs.length - 1, index + direction * step));
        this.state.runId = runs[next]?.id; void this.refresh();
      } else {
        const key = this.scrollKey();
        this.state.scroll[key] = edge ? direction < 0 ? 0 : this.maxDetailScroll : Math.max(0, Math.min(this.maxDetailScroll, (this.state.scroll[key] || 0) + direction * step));
      }
    }
    this.tui.requestRender();
  }
}

function workerExtension(pi: ExtensionAPI) {
  const token = process.env.PI_FIRE_WORKER!;
  let denied: string | undefined;
  const deny = (reason: string) => {
    if (denied) return;
    denied = reason;
    pi.sendMessage({ customType: 'fire-blocked', content: reason, display: true }, { triggerTurn: false });
  };
  pi.on('before_agent_start', event => {
    const content = 'Fire runs unattended: no human is available for additional input or approval. Complete the requested task and report results, evidence, and any unresolved blockers in your final response, not an interactive prompt. In worktree mode, local files are discarded after termination; preserve required outputs before ending.';
    event.systemPromptOptions.sections.fire = content;
    if (event.systemPromptOptions.forceSystemPrompt !== undefined) return { systemPrompt: `${event.systemPrompt}\n\n<fire>\n${content}\n</fire>` };
  });
  pi.on('ui_prompt_start', event => { deny(`Required human input unavailable: ${event.title || event.kind}. No approval was granted.`); });
  pi.on('tool_call', event => {
    if (event.toolName === 'ask_user') deny('Required human input/approval unavailable in unattended Fire execution. No approval was granted.');
    if (denied) return { block: true, reason: denied, terminate: true };
  });
  pi.registerCommand('fire-worker-start', {
    description: 'Internal owned Fire worker entry',
    handler: async (args, ctx) => {
      const newline = args.indexOf('\n');
      if (newline < 0 || args.slice(0, newline) !== token) throw new Error('Fire ownership token mismatch');
      if (!ctx.model) throw new Error('No Pi model available');
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
      if (!auth.ok) throw new Error(auth.error);
      if (!auth.apiKey && !auth.headers) throw new Error(`No Pi authentication available for ${ctx.model.provider}/${ctx.model.id}`);
      const prompt = await expandFireSkills(args.slice(newline + 1), pi.getCommands());
      pi.sendUserMessage(prompt);
    },
  });
  pi.registerCommand('fire-worker-stop', {
    description: 'Internal owned Fire cancellation',
    handler: async args => {
      if (args.trim() !== token) throw new Error('Fire ownership token mismatch');
      denied = 'Execution cancelled by user; native abort requested.';
    },
  });
  pi.registerCommand('fire-worker-exit', {
    description: 'Internal owned Fire graceful shutdown',
    handler: async (args, ctx) => { if (args.trim() !== token) throw new Error('Fire ownership token mismatch'); await ctx.waitForIdle(); ctx.shutdown(); },
  });
}

export default function fireExtension(pi: ExtensionAPI) {
  if (process.env.PI_FIRE_WORKER) { workerExtension(pi); return; }
  let enabled = false; let state = stateDefault(); let autocomplete: AutocompleteProvider | undefined;
  pi.on('session_start', (_event, ctx) => {
    enabled = false; state = stateDefault(); pi.setActiveTools(pi.getActiveTools().filter(t => t !== 'fire'));
    if (ctx.mode === 'tui') ctx.ui.addAutocompleteProvider(current => { autocomplete = current; return current; });
  });
  pi.registerTool({
    name: 'fire', label: 'Fire', description: 'Optional Fire management (enabled only by /fire tool in this session). list, conversation, preview, save, run, pause, archive, stop, delete. Destructive actions require the same human confirmation as /fire. Output capped at 40KB; use the TUI for full history.',
    parameters: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'conversation', 'preview', 'save', 'run', 'pause', 'archive', 'stop', 'delete'] }, id: { type: 'string' }, cron: { type: 'string' }, config: { type: 'object', additionalProperties: true } }, required: ['action'] } as const,
    async execute(_id, params: any, signal, _update, ctx) {
      if (!enabled || ctx.mode !== 'tui') throw new Error('Fire tool is OFF. Explicit /fire tool in this interactive session is required.');
      params = structuredClone(params);
      if (params.action === 'run' && !params.id && params.config) params.config = { ...params.config, cwd: params.config.cwd || ctx.cwd, model: ctx.model && { provider: ctx.model.provider, id: ctx.model.id }, thinking: pi.getThinkingLevel() };
      if (!['list', 'conversation', 'preview'].includes(params.action) && !await confirmFireAction(ctx, params, signal)) return { content: [{ type: 'text', text: 'Cancelled. No change.' }], details: {} };
      if (params.action === 'delete') {
        const snapshot = await requestHost(defaultRoot(), { action: 'list' });
        const verified = await reconcileDeletion(ctx, snapshot.runs.find((r: Run) => r.id === params.id));
        if (verified === undefined) return { content: [{ type: 'text', text: 'Cancelled. Evidence retained.' }], details: {} };
        params.manualCleanupVerified = verified;
      }
      if (signal?.aborted) return { content: [{ type: 'text', text: 'Cancelled. No change.' }], details: {} };
      const data = await requestHost(defaultRoot(), params); const output = JSON.stringify(data);
      return { content: [{ type: 'text', text: output.length > 40000 ? output.slice(0, 40000) + '\n[truncated; /fire for full read-only history]' : output }], details: { summary: fireToolSummary(params.action, data), truncated: output.length > 40000 } };
    },
    renderCall(args, theme) {
      return {
        render(width) {
          const target = args?.id || args?.config?.name || args?.cron || args?.config?.mode;
          return [truncateToWidth(theme.fg('toolTitle', theme.bold(`fire ${singleLine(args?.action)}`)) + (target ? theme.fg('dim', ` · ${singleLine(target)}`) : ''), Math.max(0, width), '…')];
        },
        invalidate() {},
      };
    },
    renderResult(result, { expanded, isPartial }, theme, context) {
      const output = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const details = result.details as FireToolDetails | undefined;
      let data: any;
      // Old session results have no summary; parse when possible, but never require valid JSON.
      if (expanded || !details?.summary) { try { data = JSON.parse(output); } catch {} }
      if (expanded) {
        const text = safe(data === undefined ? output : JSON.stringify(data, null, 2)).replaceAll('\t', '    ');
        return {
          render(width) {
            if (width < 1) return [];
            return new Text(theme.fg(context.isError ? 'error' : 'toolOutput', text), 0, 0).render(width).map(line => truncateToWidth(line, width, '…'));
          },
          invalidate() {},
        };
      }
      const rows: FireToolLine[] = isPartial ? [{ text: 'Waiting for Fire…', tone: 'accent' }] : context.isError ? [] : [...(details?.summary || fireToolSummary(context.args?.action, data))];
      if (!rows.length) {
        const tone = context.isError ? 'error' : output.startsWith('Cancelled.') ? 'warning' : 'toolOutput';
        rows.push(...(output || 'No output').split('\n', 3).map(text => ({ text: singleLine(text), tone } as FireToolLine)));
      }
      if (details?.truncated || output.includes('[truncated; /fire for full read-only history]')) rows.push({ text: 'Response truncated · /fire for full history', tone: 'warning' });
      return {
        render(width) {
          const hint = keyText('app.tools.expand');
          return [...rows, { text: `${hint ? hint + ' details · ' : ''}/fire history`, tone: 'dim' } as FireToolLine].map(row => truncateToWidth(theme.fg(row.tone, singleLine(row.text)), Math.max(0, width), '…'));
        },
        invalidate() {},
      };
    },
  });
  pi.registerCommand('fire', {
    description: 'Background tasks and cron: /fire, /fire run [PROMPT], /fire run-worktree [PROMPT], /fire tool',
    getArgumentCompletions(prefix) {
      const query = prefix.trimStart();
      if (/\s/.test(query)) return null;
      const items = [
        { value: 'run ', label: 'run', description: 'Run a task in the current folder' },
        { value: 'run-worktree ', label: 'run-worktree', description: 'Run in a fresh worktree, then remove it' },
        { value: 'tool', label: 'tool', description: 'Enable Fire management for this session' },
      ].filter(item => item.label.startsWith(query));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      try {
        const route = parseCommand(args);
        if (ctx.mode !== 'tui') throw new Error('/fire management requires an interactive TUI session');
        if (route.action === 'tool') {
          enabled = true; pi.setActiveTools([...new Set([...pi.getActiveTools(), 'fire'])]); ctx.ui.notify('Fire tool enabled for this session', 'info'); return;
        }
        if (route.action === 'run') {
          const submit = async (text: string) => {
            const prompt = await expandFireSkills(text, pi.getCommands());
            const run = await requestHost(defaultRoot(), { action: 'run', config: { cwd: ctx.cwd, mode: route.mode, prompt, model: ctx.model && { provider: ctx.model.provider, id: ctx.model.id }, thinking: pi.getThinkingLevel() } });
            ctx.ui.notify(`Fire accepted ${run.id}. /fire to inspect; closing Pi does not stop it.`, 'info');
            return true;
          };
          if (route.prompt) await submit(route.prompt);
          else {
            const provider = autocomplete || new CombinedAutocompleteProvider(pi.getCommands().filter(command => command.source === 'skill'), ctx.cwd);
            await ctx.ui.custom<void>((tui, theme, _keys, done) => new FirePromptComposer(tui, theme, route.mode, ctx.cwd, provider, submit, () => done(), message => ctx.ui.notify(message, 'error')), { overlay: true, overlayOptions: { width: '95%', maxHeight: '100%', anchor: 'center', margin: 1 } });
          }
          return;
        }
        let view: FireView | undefined;
        await ctx.ui.custom<void>((tui, theme, keys, done) => view = new FireView(tui, theme, keys, () => done(), ctx, state, request => requestHost(defaultRoot(), request), autocomplete || new CombinedAutocompleteProvider(pi.getCommands().filter(command => command.source === 'skill'), ctx.cwd)), { overlay: true, overlayOptions: { width: '95%', maxHeight: '100%', anchor: 'center', margin: 1 }, onHandle: handle => { if (view) view.overlay = handle; } });
      } catch (e) { ctx.ui.notify(`${stringError(e)}${/ENOENT|ECONNREFUSED/.test(stringError(e)) ? ' · Open /fire then a to explicitly activate.' : ''}`, 'error'); }
    },
  });
}
