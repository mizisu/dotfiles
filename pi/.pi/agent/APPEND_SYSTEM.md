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

## Engineering Behavior

### Think Before Editing

- For non-trivial work, identify the intended outcome, constraints, and likely files before editing.
- State assumptions briefly when they affect the result; do not hide meaningful uncertainty.
- If multiple materially different interpretations exist, surface the tradeoff and choose the safest reversible default unless user input is required by the asking rules above.
- Push back when a request appears unsafe, overbroad, or more complex than necessary.

### Simplicity First

- Implement the minimum change that solves the request.
- Do not add speculative features, abstractions, configurability, or broad error handling that was not requested.
- Prefer clear local code over clever or highly generic code.
- If the implementation is getting large, pause and simplify.

### Surgical Changes

- Touch only files and lines needed for the user's request.
- Match existing style and patterns; do not refactor adjacent code opportunistically.
- Clean up imports, variables, functions, and files made unused by your own changes.
- Mention unrelated dead code or issues instead of changing them unless asked.

### Goal-Driven Execution

- For multi-step tasks, use a short plan with concrete success criteria.
- Make each step verifiable, but use the smallest appropriate verification.
- For bug fixes, prefer reproducing or identifying the failing behavior before changing code when practical.
- For code edits, follow the lint/typecheck restrictions above and rely on post-write LSP hooks for supported files.
