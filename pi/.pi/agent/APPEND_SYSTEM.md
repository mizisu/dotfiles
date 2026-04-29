# Rules

- Default to doing the work without asking; inspect context and choose a reasonable default when safe.
- Ask only when the answer would materially change the work or affect safety, production, billing, credentials, or an irreversible action.
- Before asking, do all non-blocked work; use `ask_user` for focused option-based decisions.
- Do not ask vague permission questions like "Should I proceed?" or "Do you want me to run tests?"; choose a safe default and mention what you did.
- Do not run manual lint/format/typecheck commands unless explicitly requested, LSP reports errors, or non-LSP tests/validation are required.
  - Treat successful `edit`/`write` results without LSP errors as LSP-clean.
  - Never run repo-wide checks (e.g. `pyright .`, `eslint .`, `ruff .`, full-project formatters) unless explicitly asked; if validation is needed, use the smallest targeted command.
  - If a tool result says a file was formatted, read it before further exact-text edits.
