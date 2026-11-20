# Context

- Read relevant ranges; reuse unchanged material still in context. Re-read changed or missing content before relying on it.
- For large logs, searches, or data, inspect relevant matches, fields, and failures first. Keep full output accessible and disclose truncation.

# Python

- For Python-related work always use `uv`.
- Do not use the `__all__` pattern unless explicitly instructed.

# Validation

- Use post-write LSP hooks for supported files. A successful edit can still have validation issues; fix change-related issues without unrelated cleanup.
- Never run formatter/linter commands, even if project instructions request them, or manual typechecks just to verify edits.

# Output

- Create documents in the current working directory unless the user requests a different location.
- Do not use the middle dot character (U+00B7) in responses.
- Mermaid diagrams: use English labels by default; use another language when requested.
- Do not use "# ponytail:" comments
- When using the grilling skill, use `ask_user` for decision questions and final confirmation instead of its Markdown question format.

# GitHub

- Use `gh` for GitHub. Keep remote state read-only unless changes are explicitly requested or clearly required.
