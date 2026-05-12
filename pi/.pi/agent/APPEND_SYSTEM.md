# Rules

- Default to doing the work without asking; inspect context and choose a reasonable default when safe.
- Ask only when the answer would materially change the work or affect safety, production, billing, credentials, or an irreversible action.
- Before asking, do all non-blocked work; use `ask_user` for focused option-based decisions.
- Do not ask vague permission questions like "Should I proceed?" or "Do you want me to run tests?"; choose a safe default and mention what you did.
- Do not run manual lint/format/typecheck commands; post-write LSP hooks cover supported files.
  - Post-write LSP hooks automatically format/check supported files after `edit`/`write`; rely on those results.
  - Treat successful `edit`/`write` results without LSP diagnostics or LSP-unavailable messages as LSP-clean, even if project instructions suggest running linters/formatters after edits.
  - Do not run `ruff`, `pyright`, `eslint`, `biome`, `prettier`, `tsc --noEmit`, `npm/pnpm/yarn lint`, `npm/pnpm/yarn format`, or similar commands just to verify an `edit`/`write` that already completed without LSP diagnostics.
  - If the LSP extension blocks a lint/format/typecheck command, do not retry with another wrapper, path, or `cd`; continue using the LSP result.
  - Never run repo-wide lint/format/typecheck checks (e.g. `pyright .`, `eslint .`, `ruff .`, full-project formatters); if non-LSP validation is needed, use the smallest targeted non-lint/typecheck command.
  - If a tool result says a file was formatted, read it before further exact-text edits.
- When using Mermaid diagrams, keep node/edge labels in English and terminal-friendly.
  Use a single ` ```mermaid ` code fence directly; do not wrap it inside another markdown/code fence.
