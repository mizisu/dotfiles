# pstack on Pi

This session uses pstack from `{{PSTACK}}`. Apply the following harness mappings whenever reading its skills, playbooks, agents, or scripts. They replace Cursor-specific mechanics, not the workflow's engineering intent. Existing operator, repository, tool, and safety instructions remain authoritative. A playbook is not permission to commit, push, merge, deploy, delete data, or send external messages beyond the user's authorized scope.

## Skills and tools

- User commands are `/skill:<name>`, including `/skill:poteto-mode` and `/skill:setup-pstack`. Do not start poteto-mode merely because ppi is running.
- To invoke a referenced pstack skill, read `{{PSTACK}}/skills/<name>/SKILL.md` in full. Preserve relative paths within the upstream tree. A hidden skill is still available by its file path.
- Normal Pi skills are manual-only and available through explicit `/skill:<name>` commands. Pstack skills retain their upstream invocation policy: skills without `disable-model-invocation: true` may be selected by the model. Manual-only pstack skills may also be read when referenced by an explicitly requested workflow. For pstack references, use this upstream checkout rather than another installation or GitHub copies of files present locally.
- Cursor `Read`, `Write`, `Edit`, `Bash`, `Grep`, and `Glob` mean the matching available Pi tools. Follow the current tool instructions for choosing between search, shell, and file tools.
- Cursor `AskQuestion` means `ask_user`. If no question tool is available, ask in normal text.
- Keep playbook steps as a checklist in the conversation unless a todo tool is actually available. Do not invent `TodoWrite`.
- Discover MCP tools through the available Pi facilities. Never assume Cursor-specific tools exist.

## Delegation

Use the installed pi-subagents runtime, not Cursor `Task` and not a separate pstack task engine. Invoke `subagents_enable` when available and delegation is authorized by the user or an explicitly requested pstack workflow. Merely launching ppi does not authorize delegation.

| Cursor agent | Pi agent |
| --- | --- |
| `poteto-agent` | `ppi-poteto` |
| `generalPurpose` for writing or general tasks | `ppi-general` |
| `generalPurpose` with read-only scope | `ppi-reviewer` |
| `comment-sicko` | `ppi-comment-sicko` |

Use these ppi agents for all pstack delegates. They receive only pstack skill metadata and the same harness mappings. Pass `options: { context: "fresh" }`; do not fork an unrelated session's skill context. Give each delegate its goal, scope, evidence requirements, and absolute skill paths. The main chat owns the playbook and all agent launches; delegates are leaves.

A single task uses `subagent({ agent: "ppi-poteto", task: "...", async: true, options: { context: "fresh" } })`. Set `async: false` only when blocking is appropriate. Foreground children do not load ambient extensions; use background children when the task needs MCP or other ambient extension tools.

Parallelism uses the installed workflow API, not legacy `tasks` or `chain` fields. Write one `js workflow` block and invoke `subagent({ workflow: true, async: true, options: { context: "fresh" } })`. For example:

```js workflow
const results = await runs.all([
  { key: "first", agent: "ppi-reviewer", task: "Review the scoped diff for correctness." },
  { key: "second", agent: "ppi-reviewer", task: "Independently challenge the same scoped diff." }
]);
return results.map(result => result.output);
```

Use `action: "status"` with the returned run ID, and `bg_wait` when available, rather than busy polling. Use `action: "steer"` for a live run and `action: "resume"` only when the runtime reports a retained child as resumable. Otherwise create a fresh delegate with a consolidated brief. Never pass Cursor resume handles or unsupported fields.

Map cloud isolation to `worktree: true` for independent writers when the source checkout is clean. Map the base branch to `options.baseRef` using a supported named ref. A worktree is local isolation, not a cloud machine. Never silently stash or commit the user's changes to make isolation possible. Read-only profiles limit editing tools but shell access is not an OS sandbox.

## Models and setup-pstack

The role configuration is `{{MODEL_RULE}}`, not `~/.cursor/rules/pstack-models.mdc`. Keep this file inside the ppi installation; do not copy or symlink it into Pi's agent directory. Read it before routing a task. If the file or a role is absent, inherit the parent model; do not use upstream Grok/Claude defaults unless configured and available. A missing panel defaults to two parent-model attempts; disclose that this is not model-family diversity. Skip an arena cross-judge when no configured different-family model is available.

For `setup-pstack`, follow the upstream workflow with these substitutions:

1. Enumerate actual available model IDs through pi-subagents `action: "models"`. Do not guess IDs. Asking for setup authorizes inspecting configuration, not launching workers.
2. Keep the upstream role names and panel lists. Store model assignments as `provider/model-id:thinking`, or `inherit-parent`. Treat `auto` as an alias of `inherit-parent`.
3. Map small/medium/large/unlimited to medium/high/xhigh/max reasoning. This is not a token or price ceiling. Keep only supported effort levels.
4. Confirm the role table, then write the Markdown rule at `{{MODEL_RULE}}`, without Cursor frontmatter. Keep a budget comment and one line per role. Never change Pi's settings.json, default model, credentials, or other subagent overrides.
5. Model aliases `inherit-parent` and `auto` mean omit the tool's `model` argument; the ppi agents explicitly inherit the parent. Real assignments go in `model: "provider/model-id:thinking"`. Do not pass a dispatch `thinking` field, fabricate a `-fast` model ID, or silently switch paid providers on failure.
6. Read changes on subsequent routing decisions. Do not claim Pi automatically loads this Markdown file.

For optional verification-skill creation, ask before creating files. Generated skills under `.pi/skills/` become available as manual commands after `/reload` in a trusted project; they may also be read explicitly by their confirmed path within the authorized workflow.

## Paths, history, and unsupported features

- Cursor skill and plugin paths refer to `{{PSTACK}}/skills` and `{{PSTACK}}` here. Resolve upstream GitHub links to their local counterpart when it exists.
- Generated project skills belong under `.pi/skills/`, not `.cursor/skills/`. Do not modify the managed upstream checkout.
- For recall, automate-me, reflect, and correct, use Pi session JSONL and the current session directory supplied by the runtime. Respect session branches, compaction, workspace ownership, and user/assistant/tool roles. Never mine unrelated workspaces, treat assistant suggestions as user preferences, or run Cursor transcript helpers against Pi JSONL. Explain missing history rather than inventing it.
- `create-skill` is not a Pi builtin: author a normal SKILL.md with name/description and verify its references using available tools.
- `deslop`, `control-ui`, and `control-cli` are not bundled pstack skills. Use an already available equivalent tool or verification method; otherwise report the missing capability. Do not load unrelated skill packs automatically.
- Cursor `/loop`, Projects, cloud-agent dashboards, Automations/Benny, and Grok Bot services are not provided by this adapter. Do not promise durable overnight execution or laptop-off operation. Report a required unsupported step and its consequences; never call an unperformed verification complete.
- Existing Bugbot comments can be inspected using `gh`; do not assume a Bugbot service is installed. Use `gh` for authorized GitHub actions.
- Preserve full instructions on explicit skill re-invocation. Do not replace them with a previous-message reference.
