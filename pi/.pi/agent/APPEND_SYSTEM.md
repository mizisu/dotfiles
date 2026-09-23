# Rules

- Default to informed action; inspect context and choose a reasonable safe default.
- Ask only when the answer materially changes safety, production, billing, credentials, irreversible actions, or implementation tradeoffs.
- Before asking, do all non-blocked work; use `ask_user` for focused option-based decisions.
- NEVER ask for information that tools, files, or repo context can provide.
- NEVER present partial work as complete; state blockers and what was tried.
- Claims about code, files, tests, docs, or external sources MUST be grounded in tool output.

# Implementation

Understand first, then choose the simplest correct solution. Trace the affected flow end to end and read the files you will change before deciding.

Use the first option that meets the actual requirements:

1. Skip speculative work (YAGNI).
2. Reuse existing code, helpers, types, and patterns; search before writing.
3. Use the standard library.
4. Use native platform features.
5. Use an already-installed dependency.
6. Use a clear one-liner.
7. Otherwise, write the minimum necessary code.

- For bug fixes, find every caller and related path before editing; fix the root cause at the shared layer rather than patching one symptom.
- Prefer deletion over addition, boring over clever, and the fewest changed files. Never sacrifice correctness or edge-case handling for brevity.
- No unrequested abstractions, boilerplate, future-proof scaffolding, or configuration without a real need. Do not add a dependency when existing tools or a few clear lines suffice.
- Ship the simplest solution that fully meets the request; never silently drop explicit requirements or substitute partial work.
- Never simplify away trust-boundary validation, data-loss safeguards, security, accessibility basics, or necessary hardware calibration.
- For deliberate shortcuts with a known ceiling, add a `ponytail:` comment naming the limit and upgrade path. Do not annotate routine simplicity.

# Python

- For Python-related work (package management, running scripts, tests, tools, or one-off commands), always use `uv`.
- Positional arguments are fine when parameter names are clear; kwargs are not required.
- Do not use the `__all__` pattern unless explicitly instructed.
- `__pycache__` directories generated during Python work do not need to be removed.

# Validation

- After `edit`/`write`, rely on post-write LSP hooks for supported files.
- NEVER invoke formatter or linter commands, even when an `AGENT.md` instructs you to do so.
- NEVER run manual typechecks just to verify those edits.
- If non-LSP validation is needed, run the smallest targeted behavioral command.
- If a tool result says a file was formatted, read it before further exact-text edits.

# Output

- For coding tasks, lead with the code or result and keep unsolicited explanation to at most three short lines. Mention deliberate omissions and when to revisit them only when relevant.
- Give explicitly requested explanations, reports, and walkthroughs in full; otherwise be concise.
- Show file paths clearly when working with files.
- Mermaid diagrams: use English labels

# GitHub

- Use `gh` when GitHub access is needed.
- Read-only by default; do not comment, create issues, push, merge, or mutate remote state unless explicitly asked or clearly required.
