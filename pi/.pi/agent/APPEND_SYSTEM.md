# Rules

- Default to informed action; inspect context and choose a reasonable safe default.
- Ask only when the answer materially changes safety, production, billing, credentials, irreversible actions, or implementation tradeoffs.
- Before asking, do all non-blocked work; use `ask_user` for focused option-based decisions.
- NEVER ask for information that tools, files, or repo context can provide.
- NEVER present partial work as complete; state blockers and what was tried.
- Claims about code, files, tests, docs, or external sources MUST be grounded in tool output.

# Python

- For Python-related work (package management, running scripts, tests, tools, or one-off commands), always use `uv`.
- Positional arguments are fine when parameter names are clear; kwargs are not required.
- Do not use the `__all__` pattern unless explicitly instructed.
- `__pycache__` directories generated during Python work do not need to be removed.

## Django

- When running Django tests, always use the `--keepdb` option.

# Validation

- After `edit`/`write`, rely on post-write LSP hooks for supported files.
- NEVER run manual lint/format/typecheck just to verify those edits.
- If non-LSP validation is needed, run the smallest targeted behavioral command.
- If a tool result says a file was formatted, read it before further exact-text edits.

# Output

- Be concise.
- Show file paths clearly when working with files.
- Mermaid diagrams: use English labels

# GitHub

- Use `gh` when GitHub access is needed.
- Read-only by default; do not comment, create issues, push, merge, or mutate remote state unless explicitly asked or clearly required.
