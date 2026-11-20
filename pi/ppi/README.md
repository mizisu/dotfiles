# ppi

Run the installed Pi with its normal skill catalog plus the original pstack skills. Models, authentication, tools, extensions, prompt templates, project instructions, and session storage stay under the existing Pi configuration. The shared `zz-manual-skills.ts` extension stays active for normal Pi skills: they remain available as `/skill:<name>` commands but are hidden from automatic model selection. Skills from this pstack checkout keep their upstream invocation policy.

## Install

Requires Pi, pi-subagents with runtime-agent event registration, Git, and GitHub CLI. No npm install or separate credentials are needed.

```sh
cd ~/dotfiles/pi/ppi
./ppi update
mkdir -p ~/.local/bin
ln -s "$PWD/ppi" ~/.local/bin/ppi
```

Keep `~/.local/bin` on PATH. If `ppi` already exists, inspect it before replacing it.

## Use

```sh
ppi
ppi --continue
ppi --help
```

Inside Pi:

```text
/skill:setup-pstack
/skill:poteto-mode Reproduce this bug, fix it, and verify. Do not commit or push.
/skill:how Explain the login request flow without changing files.
/skill:grill-me Stress-test this plan.
/skill:grill-with-docs Review this design document.
/skill:grilling Challenge this decision.
```

`poteto-mode` is not activated automatically. The current upstream allows model selection for `setup-pstack`; its other 57 skills are manual-only. All discovered skills remain available as slash commands, and explicitly requested pstack workflows can read their referenced skills. The grill skills above are installed under `~/.agents/skills/` and use normal Pi discovery. Model routing defaults to the parent model. Optional role assignments live in `pstack-models.md` next to this launcher. `/skill:setup-pstack` reads and writes that file; no copy or symlink belongs in Pi's agent directory. Removing the ppi directory also removes these role assignments without changing shared Pi settings or session history.

On name collisions, Pi keeps the first discovered skill and reports a warning. In the current configuration, normal Pi's `tdd` and `teach` take precedence over the pstack slash commands with those names. Pstack workflows can still read their upstream versions by explicit path.

Restart ppi after changing the launcher; `/reload` cannot remove the old process’s `--no-skills` flag. Existing session history is preserved: resuming a session does not erase skill instructions already in its transcript. Use a new session for a clean context. Manual-only selection is not filesystem sandboxing.

Pstack delegates keep their existing pstack-only skill configuration and fresh contexts in the pi-subagents runtime. The parent owns orchestration; delegates do not spawn additional agents. Read-only delegates have no edit/write tools, but their shell is not an OS sandbox.

## Update

Exit ppi sessions and finish their background work before updating:

```sh
ppi update
```

This fast-forwards the unmodified upstream checkout. Local changes or divergent history stop the update. Nothing updates on normal startup. The checkout is ignored by dotfiles Git; retain its MIT license and notices. Pi-specific mappings stay in `pi.md` and `adapter.ts`, so upstream files do not need patches.

New upstream features can require adapter changes; a successful Git update is not a compatibility guarantee. Review the upstream changes before relying on new workflows. `ppi update` is the only reserved subcommand: it updates pstack only. Use `pi update` to update Pi and its packages. Other Pi arguments and management subcommands pass through.

Cursor Automations, cloud agents, `/loop`, Grok Bot services, and external control skill packs are not implemented. The adapter reports unavailable capabilities rather than pretending to execute them. Generated project skills under `.pi/skills/` are discovered after `/reload` in a trusted project and remain manual-only.
